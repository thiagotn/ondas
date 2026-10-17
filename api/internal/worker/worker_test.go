package worker_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/thiagotn/ondas/api/internal/acervo"
	"github.com/thiagotn/ondas/api/internal/dbtest"
	"github.com/thiagotn/ondas/api/internal/ingest"
	"github.com/thiagotn/ondas/api/internal/storage"
	"github.com/thiagotn/ondas/api/internal/worker"
)

// --- dublês ---

// baixadorDeArquivo entrega um arquivo local como se fosse a origem remota. A
// política de rede (SSRF) é testada no pacote ingest; aqui o que importa é o
// resto do caminho: examinar, subir, gravar.
type baixadorDeArquivo struct {
	caminho string
	erro    error
	chamou  int
}

func (b *baixadorDeArquivo) Baixar(_ context.Context, _ string, destino io.Writer) (string, int64, error) {
	b.chamou++
	if b.erro != nil {
		return "", 0, b.erro
	}
	f, err := os.Open(b.caminho)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	n, err := io.Copy(destino, f)
	return "audio/mpeg", n, err
}

// s3Gravador registra o que subiu, para o teste conferir chaves e tipos.
type s3Gravador struct {
	mu      sync.Mutex
	objetos map[string]string // caminho -> content-type
	falhar  bool
}

func (g *s3Gravador) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if g.falhar {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		_, _ = io.Copy(io.Discard, r.Body)
		g.mu.Lock()
		g.objetos[r.URL.Path] = r.Header.Get("Content-Type")
		g.mu.Unlock()
		if r.Method == http.MethodDelete {
			g.mu.Lock()
			delete(g.objetos, r.URL.Path)
			g.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("ETag", `"x"`)
		w.WriteHeader(http.StatusOK)
	}
}

func (g *s3Gravador) chaves() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	saida := make([]string, 0, len(g.objetos))
	for k := range g.objetos {
		saida = append(saida, k)
	}
	return saida
}

// --- ajudantes ---

func exigirFFmpeg(t *testing.T) {
	t.Helper()
	for _, bin := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s não está instalado", bin)
		}
	}
}

func mp3DeTeste(t *testing.T, titulo, artista string, comCapa bool) string {
	t.Helper()
	dir := t.TempDir()
	som := filepath.Join(dir, "som.mp3")
	args := []string{"ffmpeg", "-v", "error", "-y",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame"}
	if titulo != "" {
		args = append(args, "-metadata", "title="+titulo)
	}
	if artista != "" {
		args = append(args, "-metadata", "artist="+artista)
	}
	saida, err := exec.Command(args[0], append(args[1:], som)...).CombinedOutput()
	require.NoError(t, err, "%s", saida)
	if !comCapa {
		return som
	}
	capa := filepath.Join(dir, "capa.png")
	saida, err = exec.Command("ffmpeg", "-v", "error", "-y",
		"-f", "lavfi", "-i", "color=c=blue:s=400x400:d=1", "-frames:v", "1", capa).CombinedOutput()
	require.NoError(t, err, "%s", saida)
	final := filepath.Join(dir, "com-capa.mp3")
	saida, err = exec.Command("ffmpeg", "-v", "error", "-y", "-i", som, "-i", capa,
		"-map", "0:a", "-map", "1:v", "-c", "copy",
		"-disposition:v:0", "attached_pic", final).CombinedOutput()
	require.NoError(t, err, "%s", saida)
	return final
}

func montar(t *testing.T, bx worker.Baixador) (*worker.Worker, *acervo.Jobs, *acervo.Tracks, *s3Gravador, string) {
	t.Helper()
	pool := dbtest.Pool(t)
	g := &s3Gravador{objetos: map[string]string{}}
	srv := httptest.NewServer(g.handler())
	t.Cleanup(srv.Close)
	u, err := url.Parse(srv.URL)
	require.NoError(t, err)
	r2, err := storage.NewComEndpoint(u.Host, false, "chave", "segredo", "ondas-acervo", time.Hour)
	require.NoError(t, err)

	jobs := acervo.NewJobs(pool)
	tracks := acervo.NewTracks(pool)
	w := worker.New(jobs, tracks, r2, bx, t.TempDir(), 30*time.Second)
	dono := dbtest.CriarUsuario(t, pool, "dono@exemplo.test")
	return w, jobs, tracks, g, dono
}

// --- testes ---

// O caminho que o bot vai exercitar: URL entra, faixa tocável sai.
func TestIngestaoCompletaGravaFaixaESobeObjetos(t *testing.T) {
	exigirFFmpeg(t)
	bx := &baixadorDeArquivo{caminho: mp3DeTeste(t, "Noite Fria", "Banda Teste", true)}
	w, jobs, tracks, s3, dono := montar(t, bx)
	ctx := context.Background()

	job, _, err := jobs.Enfileirar(ctx, dono, "https://exemplo.test/noite.mp3", "", "")
	require.NoError(t, err)

	feitos, err := w.Rodar(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, feitos)

	// O job fechou apontando para a faixa.
	depois, err := jobs.PorID(ctx, dono, job.ID)
	require.NoError(t, err)
	require.Equal(t, "ready", depois.Status, "erro: %s", depois.Error)
	require.NotEmpty(t, depois.TrackID)

	// A faixa saiu com os metadados do arquivo.
	faixas, err := tracks.Listar(ctx, dono)
	require.NoError(t, err)
	require.Len(t, faixas, 1)
	f := faixas[0]
	require.Equal(t, "Noite Fria", f.Title)
	require.Equal(t, "Banda Teste", f.Artist)
	require.Equal(t, "acervo", f.Genre)
	require.InDelta(t, 2, f.DurS, 1)
	require.Equal(t, "audio/mpeg", f.AudioType)
	require.Positive(t, f.SizeBytes)

	// Áudio e as duas capas subiram, com o dono na frente da key (ADR 0011).
	chaves := s3.chaves()
	require.Len(t, chaves, 3, "esperado áudio + capa 480 + capa 150, veio %v", chaves)
	for _, k := range chaves {
		require.True(t, strings.HasPrefix(k, "/ondas-acervo/u/"+dono+"/"),
			"key deveria começar pelo dono: %s", k)
		require.NotContains(t, k, "@", "e-mail não pode entrar na key")
	}
	require.Equal(t, "audio/mpeg", s3.objetos["/ondas-acervo/"+f.AudioKey])
	require.Equal(t, "image/jpeg", s3.objetos["/ondas-acervo/"+f.ArtKey])
	require.Equal(t, "image/jpeg", s3.objetos["/ondas-acervo/"+f.ArtThumbKey])
}

// Arquivo sem arte embutida é o caso comum, não um erro.
func TestFaixaSemCapaEhIngeridaNormalmente(t *testing.T) {
	exigirFFmpeg(t)
	bx := &baixadorDeArquivo{caminho: mp3DeTeste(t, "Sem Arte", "Alguém", false)}
	w, jobs, tracks, s3, dono := montar(t, bx)
	ctx := context.Background()

	job, _, err := jobs.Enfileirar(ctx, dono, "https://exemplo.test/a.mp3", "", "")
	require.NoError(t, err)
	_, err = w.Rodar(ctx)
	require.NoError(t, err)

	depois, err := jobs.PorID(ctx, dono, job.ID)
	require.NoError(t, err)
	require.Equal(t, "ready", depois.Status, "erro: %s", depois.Error)

	faixas, err := tracks.Listar(ctx, dono)
	require.NoError(t, err)
	require.Len(t, faixas, 1)
	require.Empty(t, faixas[0].ArtKey)
	require.Empty(t, faixas[0].ArtThumbKey)
	require.Len(t, s3.chaves(), 1, "só o áudio deveria ter subido")
}

// Quem mandou a URL sabe mais que um ID3 mal preenchido.
func TestTituloDoPedidoGanhaDaTagDoArquivo(t *testing.T) {
	exigirFFmpeg(t)
	bx := &baixadorDeArquivo{caminho: mp3DeTeste(t, "Tag Errada", "Artista Da Tag", false)}
	w, jobs, tracks, _, dono := montar(t, bx)
	ctx := context.Background()

	_, _, err := jobs.Enfileirar(ctx, dono, "https://exemplo.test/a.mp3", "Nome Certo", "")
	require.NoError(t, err)
	_, err = w.Rodar(ctx)
	require.NoError(t, err)

	faixas, err := tracks.Listar(ctx, dono)
	require.NoError(t, err)
	require.Equal(t, "Nome Certo", faixas[0].Title)
	// O que o pedido não informou continua vindo da tag.
	require.Equal(t, "Artista Da Tag", faixas[0].Artist)
}

func TestArquivoSemTagGanhaPadrao(t *testing.T) {
	exigirFFmpeg(t)
	bx := &baixadorDeArquivo{caminho: mp3DeTeste(t, "", "", false)}
	w, jobs, tracks, _, dono := montar(t, bx)
	ctx := context.Background()

	_, _, err := jobs.Enfileirar(ctx, dono, "https://exemplo.test/a.mp3", "", "")
	require.NoError(t, err)
	_, err = w.Rodar(ctx)
	require.NoError(t, err)

	faixas, err := tracks.Listar(ctx, dono)
	require.NoError(t, err)
	require.Equal(t, "sem título", faixas[0].Title)
	require.Equal(t, "acervo", faixas[0].Artist)
}

// O que o dono vai ler quando a URL interna é recusada precisa explicar o
// motivo — é a pergunta "por que não funcionou?".
func TestErroDeDestinoVetadoChegaLegivelAoDono(t *testing.T) {
	bx := &baixadorDeArquivo{erro: fmt.Errorf("%w: 10.43.0.1", ingest.ErrDestinoVetado)}
	w, jobs, _, _, dono := montar(t, bx)
	ctx := context.Background()

	job, _, err := jobs.Enfileirar(ctx, dono, "http://10.43.0.1/a.mp3", "", "")
	require.NoError(t, err)
	_, err = w.Rodar(ctx)
	require.NoError(t, err)

	depois, err := jobs.PorID(ctx, dono, job.ID)
	require.NoError(t, err)
	require.Contains(t, depois.Error, "não é público")
}

// Falha de rede genérica não deve vazar endereço e porta para a mensagem.
func TestErroCruNaoVazaDetalheNaMensagem(t *testing.T) {
	bx := &baixadorDeArquivo{erro: errors.New("dial tcp 203.0.113.9:443: connect: connection refused")}
	w, jobs, _, _, dono := montar(t, bx)
	ctx := context.Background()

	job, _, err := jobs.Enfileirar(ctx, dono, "https://exemplo.test/a.mp3", "", "")
	require.NoError(t, err)
	_, err = w.Rodar(ctx)
	require.NoError(t, err)

	depois, err := jobs.PorID(ctx, dono, job.ID)
	require.NoError(t, err)
	require.NotContains(t, depois.Error, "203.0.113.9")
	require.NotContains(t, depois.Error, "dial tcp")
}

func TestJobVoltaParaFilaEDesisteDepoisDasTentativas(t *testing.T) {
	bx := &baixadorDeArquivo{erro: errors.New("origem fora do ar")}
	w, jobs, _, _, dono := montar(t, bx)
	ctx := context.Background()

	job, _, err := jobs.Enfileirar(ctx, dono, "https://exemplo.test/morta.mp3", "", "")
	require.NoError(t, err)

	for i := 0; i < acervo.MaxTentativas; i++ {
		_, err = w.Rodar(ctx)
		require.NoError(t, err)
	}
	require.Equal(t, acervo.MaxTentativas, bx.chamou, "deveria ter tentado o limite de vezes")

	depois, err := jobs.PorID(ctx, dono, job.ID)
	require.NoError(t, err)
	require.Equal(t, "error", depois.Status)

	// E para de consumir worker: a próxima rodada não pega nada.
	feitos, err := w.Rodar(ctx)
	require.NoError(t, err)
	require.Zero(t, feitos)
}

func TestArquivoQueNaoEhAudioNaoSobeNada(t *testing.T) {
	exigirFFmpeg(t)
	dir := t.TempDir()
	lixo := filepath.Join(dir, "lixo.mp3")
	require.NoError(t, os.WriteFile(lixo, []byte("isto não é música"), 0o600))

	bx := &baixadorDeArquivo{caminho: lixo}
	w, jobs, tracks, s3, dono := montar(t, bx)
	ctx := context.Background()

	job, _, err := jobs.Enfileirar(ctx, dono, "https://exemplo.test/lixo.mp3", "", "")
	require.NoError(t, err)
	_, err = w.Rodar(ctx)
	require.NoError(t, err)

	depois, err := jobs.PorID(ctx, dono, job.ID)
	require.NoError(t, err)
	require.NotEqual(t, "ready", depois.Status)
	require.Empty(t, s3.chaves(), "nada deveria ter subido")

	faixas, err := tracks.Listar(ctx, dono)
	require.NoError(t, err)
	require.Empty(t, faixas)
}

// Fila com vários: uma rodada esvazia tudo.
func TestUmaRodadaEsvaziaAFila(t *testing.T) {
	exigirFFmpeg(t)
	bx := &baixadorDeArquivo{caminho: mp3DeTeste(t, "x", "y", false)}
	w, jobs, tracks, _, dono := montar(t, bx)
	ctx := context.Background()

	for _, u := range []string{"a", "b", "c"} {
		_, _, err := jobs.Enfileirar(ctx, dono, "https://exemplo.test/"+u+".mp3", "", "")
		require.NoError(t, err)
	}
	feitos, err := w.Rodar(ctx)
	require.NoError(t, err)
	require.Equal(t, 3, feitos)

	faixas, err := tracks.Listar(ctx, dono)
	require.NoError(t, err)
	require.Len(t, faixas, 3)
}

func TestFilaVaziaNaoEhErro(t *testing.T) {
	w, _, _, _, _ := montar(t, &baixadorDeArquivo{})
	feitos, err := w.Rodar(context.Background())
	require.NoError(t, err)
	require.Zero(t, feitos)
}
