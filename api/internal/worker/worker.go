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

// Tamanhos das capas: a grande para o player e o fundo, a pequena para o thumb
// da lista.
//
// A grande é 960 e não 480 (o que a PWA pede do Audius) porque o player mostra
// a capa com 400px de CSS: numa tela 2x isso são 800px físicos, e 480 ali é
// ampliação — foi o que gerou a queixa de nitidez. Como `ExtrairCapa` nunca
// amplia, pedir 960 é pedir "o que a fonte tiver até 960", sem custo quando a
// arte é menor.
//
// Mudar estes números não mexe no que já está no acervo: a key de cada capa
// fica guardada na faixa, e só a ingestão nova usa o valor daqui.
const (
	ladoCapa  = 960
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
	maxBytes int64
}

func New(jobs *acervo.Jobs, tracks *acervo.Tracks, r2 *storage.R2,
	baixador Baixador, dirTrabalho string, prazo time.Duration, maxBytes int64) *Worker {
	return &Worker{
		jobs: jobs, tracks: tracks, r2: r2, baixador: baixador,
		trabalho: dirTrabalho, prazo: prazo, maxBytes: maxBytes,
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
	w.descartarEnvio(ctx, job, log)
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
	case errors.Is(err, storage.ErrObjetoAusente):
		return "o arquivo enviado não está mais no bucket — refaça o envio"
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
	tipoDeclarado, tamanho, err := w.origem(ctx, job, arquivo)
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

	// O DONO DA FAIXA PODE NÃO SER QUEM PEDIU (migração 0007). `job.UserID` é
	// quem mandou; `job.DestinoID`, quando existe, é de quem a faixa será.
	//
	// A diferença importa aqui e NÃO importa na área de espera: `job.UserID`
	// continua sendo a única coisa que reconstrói a key do stage, porque foi na
	// área dele que o arquivo foi gravado (ver `finalizarUpload`).
	dono := job.UserID
	if job.DestinoID != "" {
		dono = job.DestinoID
	}

	// Key com o dono na frente, como as fotos do prumo (ADR 0011): a fronteira
	// fica legível no bucket, não só no banco. Nada de e-mail ou nome aqui —
	// key aparece em log e em mensagem de erro.
	//
	// É `dono` e não `job.UserID`: a key não é fronteira de acesso (quem libera
	// é o 302 assinado, depois da checagem no banco), mas deixar a faixa de uma
	// pessoa sob o prefixo de outra faria qualquer varredura ou limpeza por dono
	// mentir.
	audioKey := fmt.Sprintf("u/%s/a/%s.%s", dono, trackID, midia.Ext)

	if err := w.enviarArquivo(ctx, bruto, audioKey, midia.ContentType, tamanho); err != nil {
		return nil, err
	}

	artKey, thumbKey := w.capas(ctx, dir, bruto, dono, trackID, midia, log)

	// Best-effort, como as capas: faixa sem forma de onda desenha barra lisa,
	// e isso não é motivo para reprovar uma ingestão que já subiu o áudio.
	picos, err := ingest.Picos(ctx, bruto, midia.DuracaoS)
	if err != nil {
		log.Warn("forma de onda não medida", "erro", err)
		picos = ""
	}

	nova := acervo.Nova{
		ID:     trackID,
		UserID: dono,
		// Ordem: título escolhido no pedido > tags do arquivo > nome do
		// arquivo enviado > padrão. O nome do arquivo entra DEPOIS das tags
		// de propósito: um álbum etiquetado não deve virar "01 - Faixa".
		Title:       primeiroNaoVazio(job.Title, midia.Titulo, job.TituloReserva, "sem título"),
		Artist:      primeiroNaoVazio(job.Artist, midia.Artista, "acervo"),
		Genre:       "acervo",
		DurS:        midia.DuracaoS,
		AudioKey:    audioKey,
		AudioType:   midia.ContentType,
		SizeBytes:   tamanho,
		ArtKey:      artKey,
		ArtThumbKey: thumbKey,
		Peaks:       picos,
		// Vazia vira `privada` no SQL — faixa nunca nasce publicada por um
		// campo esquecido no caminho.
		Visibilidade: job.Visibilidade,
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

// IdadeAbandono é o tempo após o qual um arquivo na área de espera é lixo.
//
// Folgado de propósito: o pior caso de um job legítimo é 3 tentativas com
// recuperação de travado a cada 15 minutos — menos de uma hora. 24h não corre
// risco de apagar arquivo que ainda vai ser ingerido.
const IdadeAbandono = 24 * time.Hour

// VarrerAbandonados apaga o que subiu e nunca foi finalizado: aba fechada no
// meio do envio, usuário que desistiu, erro de rede entre o PUT e o
// `finalizar`. Sem isto esses bytes ficam pagando armazenamento para sempre,
// sem nenhuma linha no banco que os aponte.
//
// Devolve quantos apagou. Erro de um objeto não interrompe os outros: a
// varredura é oportunista e roda de novo daqui a pouco.
func (w *Worker) VarrerAbandonados(ctx context.Context) (int, error) {
	keys, err := w.r2.StageAbandonados(ctx, IdadeAbandono)
	if err != nil {
		return 0, err
	}
	apagados := 0
	for _, k := range keys {
		if err := w.r2.Remover(ctx, k); err != nil {
			slog.Warn("abandonado continuou no bucket", "key", k, "erro", err)
			continue
		}
		apagados++
	}
	return apagados, nil
}

// origem busca os bytes da mídia. São duas fontes para uma pipeline só: URL
// pública (baixador HTTP, com a trava de SSRF) e arquivo que um cliente
// autenticado já gravou no bucket — a tela de envio da PWA ou o node do
// Hermes, pela skill do SoundCloud.
//
// A key do envio é RECONSTRUÍDA do `user_id` do job; o que está guardado na
// linha é só um id (ver acervo.FonteUpload). É essa reconstrução, e não o
// middleware da API, que protege esta fonte: uma fonte adulterada no banco não
// vira caminho que o worker obedece, porque o worker nunca lê um caminho — ele
// monta o dele a partir do dono do job.
//
// Vale dizer o que mudou aqui: desde a skill do SoundCloud, o token de máquina
// ALCANÇA esta fonte, pelo `finalizar`. Antes não alcançava, e o comentário
// antigo se apoiava nisso. A garantia que continua de pé é a de cima.
func (w *Worker) origem(ctx context.Context, job *acervo.Job, destino io.Writer) (string, int64, error) {
	id, ok := acervo.IDDoUpload(job.SourceURL)
	if !ok {
		return w.baixador.Baixar(ctx, job.SourceURL, destino)
	}
	tipo, n, err := w.r2.Baixar(ctx, storage.KeyUploadStage(job.UserID, id), destino, w.maxBytes)
	if err != nil {
		return "", 0, err
	}
	// O teto é reconferido aqui, e não só no `finalizar` da API, porque a URL
	// assinada do PUT segue válida por 15 minutos: o arquivo pode ter sido
	// trocado por um maior DEPOIS da conferência. Sem isto, o emptyDir de 1Gi
	// enche e o pod morre.
	if w.maxBytes > 0 && n > w.maxBytes {
		return "", 0, fmt.Errorf("%w de %d bytes", ingest.ErrGrandeDemais, w.maxBytes)
	}
	return tipo, n, nil
}

// descartarEnvio apaga o arquivo da área de espera depois que a faixa ficou
// pronta: os bytes já estão no objeto definitivo, com tipo e extensão certos,
// e manter a cópia crua seria pagar armazenamento duas vezes.
//
// Só no sucesso. Numa falha o objeto fica, porque o job ainda pode ser
// retentado; quem recolhe o que sobrou é a varredura de abandonados.
func (w *Worker) descartarEnvio(ctx context.Context, job *acervo.Job, log *slog.Logger) {
	id, ok := acervo.IDDoUpload(job.SourceURL)
	if !ok {
		return
	}
	w.limpar(ctx, log, storage.KeyUploadStage(job.UserID, id))
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
		destino *string
	}{
		{ladoCapa, &artKey},
		{ladoThumb, &thumbKey},
	} {
		// O nome sai do próprio lado: eram dois lugares para manter em acordo,
		// e a key é o que a PWA pede depois.
		local := filepath.Join(dir, fmt.Sprintf("capa-%d.jpg", c.lado))
		if err := ingest.ExtrairCapa(ctx, origem, local, c.lado); err != nil {
			log.Warn("capa não extraída", "lado", c.lado, "erro", err)
			continue
		}
		info, err := os.Stat(local)
		if err != nil {
			log.Warn("capa sem arquivo", "lado", c.lado, "erro", err)
			continue
		}
		key := fmt.Sprintf("u/%s/art/%s-%d.jpg", userID, trackID, c.lado)
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
