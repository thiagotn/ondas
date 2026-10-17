// Worker de ingestão do acervo: consome a fila ingest_jobs, baixa a mídia da
// URL pedida, examina com ffprobe, sobe no R2 e grava a faixa.
//
// Binário separado da API porque a imagem dela é scratch e aqui precisa de
// ffmpeg. Sem Service nem Ingress: a :9090 só serve /healthz para o kubelet.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/thiagotn/ondas/api/internal/acervo"
	"github.com/thiagotn/ondas/api/internal/config"
	"github.com/thiagotn/ondas/api/internal/db"
	"github.com/thiagotn/ondas/api/internal/ingest"
	"github.com/thiagotn/ondas/api/internal/storage"
	"github.com/thiagotn/ondas/api/internal/worker"
)

const dirTrabalho = "/tmp"

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	// `worker cors <origem>` aplica a política de CORS do bucket e sai. Mora
	// aqui, e não num `aws-cli` avulso, por três motivos: a imagem já está no
	// nó (o aws-cli seriam ~400MB de pull novo), a política fica versionada
	// como código em vez de JSON colado num painel, e a credencial não precisa
	// sair do cluster.
	if len(os.Args) > 1 && os.Args[1] == "cors" {
		if err := aplicarCORS(os.Args[2:]); err != nil {
			slog.Error("cors", "erro", err)
			os.Exit(1)
		}
		return
	}

	// `worker conferir <track-id>` prova que a faixa está tocável: objeto no
	// bucket e URL assinada honrando Range.
	if len(os.Args) > 1 && os.Args[1] == "conferir" {
		if err := conferir(os.Args[2:]); err != nil {
			slog.Error("conferir", "erro", err)
			os.Exit(1)
		}
		return
	}

	if err := run(); err != nil {
		slog.Error("encerrando", "erro", err)
		os.Exit(1)
	}
}

func aplicarCORS(args []string) error {
	if len(args) != 1 {
		return errors.New("uso: worker cors https://origem.da.pwa")
	}
	origem := args[0]

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if !cfg.AcervoConfigurado() {
		return errors.New("sem credencial de R2 (R2_ACCOUNT_ID/ACCESS_KEY_ID/SECRET_ACCESS_KEY)")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	r2, err := storage.New(cfg.R2AccountID, cfg.R2AccessKeyID, cfg.R2SecretAccessKey,
		cfg.R2Bucket, time.Duration(cfg.R2SignedURLTTLS)*time.Second)
	if err != nil {
		return err
	}
	if err := r2.AplicarCORS(ctx, origem); err != nil {
		return err
	}
	// Ler de volta é o que prova que gravou — o PUT pode devolver 200 e o
	// bucket ficar sem nada se a política for recusada em silêncio.
	politica, err := r2.LerCORS(ctx)
	if err != nil {
		return fmt.Errorf("gravou mas não deu para conferir: %w", err)
	}
	if !strings.Contains(politica, origem) {
		return fmt.Errorf("a política no bucket não contém %q:\n%s", origem, politica)
	}
	slog.Info("CORS aplicado", "bucket", cfg.R2Bucket, "origem", origem)
	fmt.Println(politica)
	return nil
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	// Diferente da API: sem R2 o worker não tem o que fazer, então falha alto
	// em vez de subir e ficar girando em falso.
	if !cfg.AcervoConfigurado() {
		return errors.New("worker exige R2_ACCOUNT_ID/ACCESS_KEY_ID/SECRET_ACCESS_KEY")
	}

	ctx, parar := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer parar()

	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	// O worker também migra: as migrações correm sob advisory lock, então quem
	// sobe primeiro não importa e não há ordem de deploy para lembrar.
	if err := db.Migrate(ctx, pool); err != nil {
		return err
	}

	r2, err := storage.New(cfg.R2AccountID, cfg.R2AccessKeyID, cfg.R2SecretAccessKey,
		cfg.R2Bucket, time.Duration(cfg.R2SignedURLTTLS)*time.Second)
	if err != nil {
		return err
	}

	prazo := time.Duration(cfg.IngestTimeoutS) * time.Second
	w := worker.New(
		acervo.NewJobs(pool),
		acervo.NewTracks(pool),
		r2,
		ingest.NewBaixador(int64(cfg.IngestMaxMB)<<20, prazo),
		dirTrabalho,
		prazo,
	)

	srv := servidorDeSaude()
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("servidor de saúde", "erro", err)
		}
	}()

	intervalo := time.Duration(cfg.WorkerPollS) * time.Second
	slog.Info("worker no ar", "bucket", cfg.R2Bucket, "intervalo", intervalo,
		"max_mb", cfg.IngestMaxMB)

	tick := time.NewTicker(intervalo)
	defer tick.Stop()
	for {
		feitos, err := w.Rodar(ctx)
		if err != nil && ctx.Err() == nil {
			slog.Error("rodada do worker", "erro", err)
		}
		if ctx.Err() != nil {
			slog.Info("desligando", "jobs_na_ultima_rodada", feitos)
			desliga, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			return srv.Shutdown(desliga)
		}
		select {
		case <-ctx.Done():
		case <-tick.C:
		}
	}
}

// servidorDeSaude expõe /healthz (kubelet). Não confere o banco de propósito:
// Postgres piscando não é motivo para matar um worker que está no meio de um
// download.
func servidorDeSaude() *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})
	return &http.Server{Addr: ":9090", Handler: mux, ReadHeaderTimeout: 5 * time.Second}
}
