package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/thiagotn/ondas/api/internal/config"
	"github.com/thiagotn/ondas/api/internal/db"
	"github.com/thiagotn/ondas/api/internal/storage"
)

type faixaComCapa struct {
	ID       string
	Title    string
	ArtKey   string
	ThumbKey string
}

func faixasSemTamanhoDeCapa(ctx context.Context, pool *pgxpool.Pool) ([]faixaComCapa, error) {
	linhas, err := pool.Query(ctx, `
		SELECT id, title, coalesce(art_key, ''), coalesce(art_thumb_key, '')
		  FROM tracks
		 WHERE art_bytes = 0 AND (art_key IS NOT NULL OR art_thumb_key IS NOT NULL)
		 ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer linhas.Close()

	var saida []faixaComCapa
	for linhas.Next() {
		var f faixaComCapa
		if err := linhas.Scan(&f.ID, &f.Title, &f.ArtKey, &f.ThumbKey); err != nil {
			return nil, err
		}
		saida = append(saida, f)
	}
	return saida, linhas.Err()
}

// medirCapas preenche `tracks.art_bytes` das faixas ingeridas antes da
// migração 0012.
//
// O worker sempre mediu a capa na hora de subir e jogava o número fora; quem
// já estava no acervo ficou com 0, e a ocupação da conta fica menor que a do
// bucket até este comando passar. Ele não baixa nada: pergunta o tamanho de
// cada objeto ao R2 (HEAD) e soma.
//
// Não escreve nada sem `--gravar`, como o `repicos`: o padrão de um comando que
// mexe em produção tem de ser o inofensivo. E a guarda `art_bytes = 0` se
// repete no UPDATE, para nunca passar por cima de uma medição feita por uma
// ingestão que entrou no meio.
func medirCapas(args []string) error {
	fs := flag.NewFlagSet("medir-capas", flag.ContinueOnError)
	gravar := fs.Bool("gravar", false, "escreve no banco; sem isto só lista o que mudaria")
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if !cfg.AcervoConfigurado() {
		return errors.New("sem credencial de R2")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	faixas, err := faixasSemTamanhoDeCapa(ctx, pool)
	if err != nil {
		return fmt.Errorf("listar faixas sem tamanho de capa: %w", err)
	}
	if len(faixas) == 0 {
		fmt.Println("nada a fazer: toda capa já tem tamanho.")
		return nil
	}

	modo := "ENSAIO (nada será escrito; use --gravar)"
	if *gravar {
		modo = "GRAVANDO"
	}
	fmt.Printf("%d faixa(s) com capa sem tamanho — %s\n\n", len(faixas), modo)

	r2, err := storage.New(cfg.R2AccountID, cfg.R2AccessKeyID, cfg.R2SecretAccessKey,
		cfg.R2Bucket, time.Duration(cfg.R2SignedURLTTLS)*time.Second)
	if err != nil {
		return err
	}

	var ok, falhas int
	var total int64
	for i, f := range faixas {
		var bytes int64
		falhou := false
		for _, key := range []string{f.ArtKey, f.ThumbKey} {
			if key == "" {
				continue
			}
			n, err := r2.Tamanho(ctx, key)
			if errors.Is(err, storage.ErrObjetoAusente) {
				// A linha aponta para uma capa que não está no bucket: não é
				// espaço ocupado, então não conta — e não é motivo para falhar.
				continue
			}
			if err != nil {
				fmt.Printf("[%d/%d] %s (%s): FALHOU: %v\n", i+1, len(faixas), f.Title, f.ID, err)
				falhou = true
				break
			}
			bytes += n
		}
		if falhou {
			falhas++
			continue
		}
		fmt.Printf("[%d/%d] %s (%s): %d bytes\n", i+1, len(faixas), f.Title, f.ID, bytes)
		total += bytes
		if !*gravar || bytes == 0 {
			ok++
			continue
		}
		if _, err := pool.Exec(ctx,
			`UPDATE tracks SET art_bytes = $1 WHERE id = $2 AND art_bytes = 0`, bytes, f.ID); err != nil {
			fmt.Printf("    não gravou: %v\n", err)
			falhas++
			continue
		}
		ok++
	}

	fmt.Printf("\n%d medida(s), %d falha(s), %d bytes de capa no total.\n", ok, falhas, total)
	if falhas > 0 {
		return fmt.Errorf("%d faixa(s) não foram medidas", falhas)
	}
	return nil
}
