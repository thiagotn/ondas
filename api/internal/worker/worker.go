// Package worker consome a fila de ingestão: baixa a mídia da URL, examina,
// sobe no R2 e grava a faixa.
//
// Vive num processo separado da API porque baixar uma URL arbitrária não cabe
// no ReadTimeout de 15s do servidor HTTP (mesmo argumento da ADR 0007, que
// criou o worker do rachão), e numa imagem separada porque precisa de ffmpeg —
// a da API é scratch.
package worker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/thiagotn/ondas/api/internal/acervo"
	"github.com/thiagotn/ondas/api/internal/ingest"
	"github.com/thiagotn/ondas/api/internal/storage"
)

// Tamanhos das capas: 480 para o fundo/player e 150 para o thumb da lista —
// os mesmos que a PWA já pede do Audius.
const (
	ladoCapa  = 480
	ladoThumb = 150
)

// Baixador é o que o worker precisa de quem busca a mídia. Interface, e não o
// `*ingest.Baixador` concreto, por dois motivos: o worker não tem nada a dizer
// sobre política de rede, e o teste de ponta a ponta precisa servir um arquivo
// local — que a trava de SSRF do baixador de produção recusa, com razão. A
// trava é testada onde ela mora, no pacote ingest.
type Baixador interface {
	Baixar(ctx context.Context, url string, destino io.Writer) (contentType string, tamanho int64, err error)
}

type Worker struct {
	jobs     *acervo.Jobs
	tracks   *acervo.Tracks
	r2       *storage.R2
	baixador Baixador
	trabalho string
	prazo    time.Duration
}

func New(jobs *acervo.Jobs, tracks *acervo.Tracks, r2 *storage.R2,
	baixador Baixador, dirTrabalho string, prazo time.Duration) *Worker {
	return &Worker{
		jobs: jobs, tracks: tracks, r2: r2, baixador: baixador,
		trabalho: dirTrabalho, prazo: prazo,
	}
}

// Rodar processa a fila até o contexto ser cancelado. Devolve quantos jobs
// pegou nesta rodada, para o laço saber se vale tentar de novo na hora.
func (w *Worker) Rodar(ctx context.Context) (int, error) {
	feitos := 0
	for {
		job, err := w.jobs.Reivindicar(ctx)
		if errors.Is(err, acervo.ErrFilaVazia) {
			return feitos, nil
		}
		if err != nil {
			return feitos, err
		}
		feitos++
		w.processar(ctx, job)
		if ctx.Err() != nil {
			return feitos, ctx.Err()
		}
	}
}

func (w *Worker) processar(ctx context.Context, job *acervo.Job) {
	log := slog.With("job", job.ID, "tentativa", job.Attempts)
	log.Info("ingestão começou")

	// WithoutCancel de propósito: o SIGTERM do rollout não deve abortar uma
	// ingestão em curso — ela gastaria uma tentativa por um deploy. O laço
	// acima é que para de pegar job novo; o terminationGracePeriod do
	// Deployment dá tempo para esta terminar. O prazo por job continua, para
	// que uma origem lenta não prenda o worker para sempre.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), w.prazo)
	defer cancel()

	track, err := w.ingerir(ctx, job, log)
	if err != nil {
		// A mensagem vai para o banco e o bot a lê: tem de dizer o que
		// aconteceu sem vazar o que não interessa.
		log.Error("ingestão falhou", "erro", err)
		if erroMarcar := w.jobs.Falhar(ctx, job.ID, mensagemDeErro(err)); erroMarcar != nil {
			log.Error("não deu para marcar a falha", "erro", erroMarcar)
		}
		return
	}
	if err := w.jobs.Concluir(ctx, job.ID, track.ID); err != nil {
		log.Error("faixa gravada mas job não fechou", "track", track.ID, "erro", err)
		return
	}
	log.Info("ingestão pronta", "track", track.ID, "titulo", track.Title, "dur", track.DurS)
}

// mensagemDeErro escolhe o que o dono vai ler no status do job.
//
// Erro de destino vetado aparece inteiro de propósito: é a resposta para "por
// que minha URL interna não funciona". Já erro de rede cru pode carregar
// endereço e porta, então vira texto genérico.
func mensagemDeErro(err error) string {
	switch {
	case errors.Is(err, ingest.ErrDestinoVetado):
		return "endereço de destino não é público — só URLs da internet"
	case errors.Is(err, ingest.ErrURLInvalida):
		return "url inválida"
	case errors.Is(err, ingest.ErrGrandeDemais):
		return err.Error()
	case errors.Is(err, ingest.ErrSemAudio):
		return "o arquivo não tem faixa de áudio"
	case errors.Is(err, ingest.ErrFormatoNaoToca):
		return err.Error()
	case errors.Is(err, context.DeadlineExceeded):
		return "a origem demorou demais"
	default:
		return "não foi possível ingerir esta mídia"
	}
}

func (w *Worker) ingerir(ctx context.Context, job *acervo.Job, log *slog.Logger) (*acervo.Track, error) {
	// Um diretório por job, apagado no fim: o emptyDir é pequeno e dois jobs
	// seguidos não podem herdar sobra um do outro.
	dir, err := os.MkdirTemp(w.trabalho, "ingest-")
	if err != nil {
		return nil, fmt.Errorf("dir temporário: %w", err)
	}
	defer os.RemoveAll(dir)

	bruto := filepath.Join(dir, "origem")
	arquivo, err := os.Create(bruto)
	if err != nil {
		return nil, err
	}
	tipoDeclarado, tamanho, err := w.baixador.Baixar(ctx, job.SourceURL, arquivo)
	if cerr := arquivo.Close(); err == nil && cerr != nil {
		err = cerr
	}
	if err != nil {
		return nil, err
	}
	log.Info("baixado", "bytes", tamanho, "content-type-declarado", tipoDeclarado)

	midia, err := ingest.Examinar(ctx, bruto)
	if err != nil {
		return nil, err
	}

	trackID := uuid.NewString()
	// Key com o dono na frente, como as fotos do prumo (ADR 0011): a fronteira
	// fica legível no bucket, não só no banco. Nada de e-mail ou nome aqui —
	// key aparece em log e em mensagem de erro.
	audioKey := fmt.Sprintf("u/%s/a/%s.%s", job.UserID, trackID, midia.Ext)

	if err := w.enviarArquivo(ctx, bruto, audioKey, midia.ContentType, tamanho); err != nil {
		return nil, err
	}

	artKey, thumbKey := w.capas(ctx, dir, bruto, job.UserID, trackID, midia, log)

	nova := acervo.Nova{
		ID:          trackID,
		UserID:      job.UserID,
		Title:       primeiroNaoVazio(job.Title, midia.Titulo, "sem título"),
		Artist:      primeiroNaoVazio(job.Artist, midia.Artista, "acervo"),
		Genre:       "acervo",
		DurS:        midia.DuracaoS,
		AudioKey:    audioKey,
		AudioType:   midia.ContentType,
		SizeBytes:   tamanho,
		ArtKey:      artKey,
		ArtThumbKey: thumbKey,
	}
	track, err := w.tracks.Criar(ctx, nova)
	if err != nil {
		// O áudio já subiu: sem esta limpeza o objeto fica órfão pagando
		// armazenamento sem nenhuma linha que o aponte.
		w.limpar(ctx, log, audioKey, artKey, thumbKey)
		return nil, fmt.Errorf("gravar faixa: %w", err)
	}
	return track, nil
}

// capas é best-effort: faixa sem arte embutida é normal e não deve reprovar a
// ingestão — a PWA já sabe mostrar linha sem capa.
func (w *Worker) capas(ctx context.Context, dir, origem, userID, trackID string,
	midia *ingest.Midia, log *slog.Logger) (artKey, thumbKey string) {
	if !midia.TemCapa {
		return "", ""
	}
	for _, c := range []struct {
		lado    int
		sufixo  string
		destino *string
	}{
		{ladoCapa, "480", &artKey},
		{ladoThumb, "150", &thumbKey},
	} {
		local := filepath.Join(dir, "capa-"+c.sufixo+".jpg")
		if err := ingest.ExtrairCapa(ctx, origem, local, c.lado); err != nil {
			log.Warn("capa não extraída", "lado", c.lado, "erro", err)
			continue
		}
		info, err := os.Stat(local)
		if err != nil {
			log.Warn("capa sem arquivo", "lado", c.lado, "erro", err)
			continue
		}
		key := fmt.Sprintf("u/%s/art/%s-%s.jpg", userID, trackID, c.sufixo)
		if err := w.enviarArquivo(ctx, local, key, "image/jpeg", info.Size()); err != nil {
			log.Warn("capa não subiu", "lado", c.lado, "erro", err)
			continue
		}
		*c.destino = key
	}
	return artKey, thumbKey
}

func (w *Worker) enviarArquivo(ctx context.Context, caminho, key, contentType string, tamanho int64) error {
	f, err := os.Open(caminho)
	if err != nil {
		return err
	}
	defer f.Close()
	return w.r2.Enviar(ctx, key, contentType, f, tamanho)
}

func (w *Worker) limpar(ctx context.Context, log *slog.Logger, keys ...string) {
	for _, k := range keys {
		if k == "" {
			continue
		}
		if err := w.r2.Remover(ctx, k); err != nil {
			log.Error("objeto órfão no R2", "key", k, "erro", err)
		}
	}
}

// primeiroNaoVazio: o que o pedido informou ganha das tags do arquivo, e as
// tags ganham do padrão — quem mandou a URL sabe mais que um ID3 mal preenchido.
func primeiroNaoVazio(valores ...string) string {
	for _, v := range valores {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}
