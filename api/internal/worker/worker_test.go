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
	"sort"
	"strconv"
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

// s3Gravador é um S3 de brinquedo. Começou só registrando o que subia; passou
// a GUARDAR e SERVIR bytes quando o worker ganhou a fonte `upload:`, em que a
// mídia vem do próprio bucket em vez de uma URL — um dublê que só aceitasse
// escrita não provaria nada desse caminho.
type objetoFalso struct {
	tipo    string
	dados   []byte
	gravado time.Time
}

type s3Gravador struct {
	mu      sync.Mutex
	objetos map[string]objetoFalso
	falhar  bool
}

func (g *s3Gravador) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if g.falhar {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		switch r.Method {
		case http.MethodPut:
			corpo, _ := io.ReadAll(r.Body)
			g.gravar(r.URL.Path, r.Header.Get("Content-Type"), corpo)
			w.Header().Set("ETag", `"x"`)
			w.WriteHeader(http.StatusOK)
		case http.MethodGet, http.MethodHead:
			// ListObjects também é GET, mas na raiz do bucket e com query.
			if r.URL.Query().Has("list-type") {
				g.listar(w, r.URL.Query().Get("prefix"))
				return
			}
			obj, ok := g.obter(r.URL.Path)
			if !ok {
				naoExiste(w, r.URL.Path)
				return
			}
			w.Header().Set("Content-Type", obj.tipo)
			w.Header().Set("Content-Length", strconv.Itoa(len(obj.dados)))
			w.Header().Set("Last-Modified", obj.gravado.UTC().Format(http.TimeFormat))
			w.Header().Set("ETag", `"x"`)
			w.WriteHeader(http.StatusOK)
			if r.Method == http.MethodGet {
				_, _ = w.Write(obj.dados)
			}
		case http.MethodDelete:
			g.remover(r.URL.Path)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}
}

// naoExiste responde como o S3 responde: 404 com o código que o minio traduz
// em erro de objeto ausente. É o que faz `storage.ErrObjetoAusente` aparecer.
func naoExiste(w http.ResponseWriter, caminho string) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(http.StatusNotFound)
	_, _ = fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?>`+
		`<Error><Code>NoSuchKey</Code><Message>nao existe</Message><Key>%s</Key></Error>`,
		strings.TrimPrefix(caminho, "/ondas-acervo/"))
}

func (g *s3Gravador) listar(w http.ResponseWriter, prefixo string) {
	g.mu.Lock()
	type item struct {
		key string
		obj objetoFalso
	}
	var itens []item
	for caminho, obj := range g.objetos {
		key := strings.TrimPrefix(caminho, "/ondas-acervo/")
		if strings.HasPrefix(key, prefixo) {
			itens = append(itens, item{key, obj})
		}
	}
	g.mu.Unlock()
	sort.Slice(itens, func(i, j int) bool { return itens[i].key < itens[j].key })

	var b strings.Builder
	fmt.Fprintf(&b, `<?xml version="1.0" encoding="UTF-8"?>`+
		`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`+
		`<Name>ondas-acervo</Name><Prefix>%s</Prefix><KeyCount>%d</KeyCount>`+
		`<MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>`, prefixo, len(itens))
	for _, it := range itens {
		fmt.Fprintf(&b, `<Contents><Key>%s</Key><LastModified>%s</LastModified>`+
			`<ETag>&#34;x&#34;</ETag><Size>%d</Size><StorageClass>STANDARD</StorageClass></Contents>`,
			it.key, it.obj.gravado.UTC().Format("2006-01-02T15:04:05.000Z"), len(it.obj.dados))
	}
	b.WriteString(`</ListBucketResult>`)
	w.Header().Set("Content-Type", "application/xml")
	_, _ = w.Write([]byte(b.String()))
}

func (g *s3Gravador) gravar(caminho, tipo string, dados []byte) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.objetos[caminho] = objetoFalso{tipo: tipo, dados: dados, gravado: time.Now()}
}

// semear põe um objeto no bucket como se ele já estivesse lá — é assim que o
// teste monta uma área de espera com arquivo enviado pelo navegador.
func (g *s3Gravador) semear(key, tipo string, dados []byte, gravado time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.objetos["/ondas-acervo/"+key] = objetoFalso{tipo: tipo, dados: dados, gravado: gravado}
}

func (g *s3Gravador) obter(caminho string) (objetoFalso, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	obj, ok := g.objetos[caminho]
	return obj, ok
}

func (g *s3Gravador) remover(caminho string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.objetos, caminho)
}

func (g *s3Gravador) tipo(key string) string {
	obj, _ := g.obter("/ondas-acervo/" + key)
	return obj.tipo
}

func (g *s3Gravador) tem(key string) bool {
	_, ok := g.obter("/ondas-acervo/" + key)
	return ok
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

// tetoDeTeste é generoso: os casos que importam para o teto têm o seu próprio
// worker, montado com `montarComTeto`.
const tetoDeTeste = 8 << 20

func montar(t *testing.T, bx worker.Baixador) (*worker.Worker, *acervo.Jobs, *acervo.Tracks, *s3Gravador, string) {
	return montarComTeto(t, bx, tetoDeTeste)
}

func montarComTeto(t *testing.T, bx worker.Baixador, teto int64) (*worker.Worker, *acervo.Jobs, *acervo.Tracks, *s3Gravador, string) {
	t.Helper()
	pool := dbtest.Pool(t)
	g := &s3Gravador{objetos: map[string]objetoFalso{}}
	srv := httptest.NewServer(g.handler())
	t.Cleanup(srv.Close)
	u, err := url.Parse(srv.URL)
	require.NoError(t, err)
	r2, err := storage.NewComEndpoint(u.Host, false, "chave", "segredo", "ondas-acervo", time.Hour)
	require.NoError(t, err)

	jobs := acervo.NewJobs(pool)
	tracks := acervo.NewTracks(pool)
	w := worker.New(jobs, tracks, r2, bx, t.TempDir(), 30*time.Second, teto)
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
	require.Equal(t, "audio/mpeg", s3.tipo(f.AudioKey))
	require.Equal(t, "image/jpeg", s3.tipo(f.ArtKey))
	require.Equal(t, "image/jpeg", s3.tipo(f.ArtThumbKey))
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

// --- fonte `upload:` (tela de envio) ---

// baixadorQueNaoDeveriaSerChamado prova que a fonte `upload:` não encosta no
// caminho HTTP: se o worker tentar baixar da internet, o teste quebra.
type baixadorQueNaoDeveriaSerChamado struct{ t *testing.T }

func (b *baixadorQueNaoDeveriaSerChamado) Baixar(context.Context, string, io.Writer) (string, int64, error) {
	b.t.Error("o worker tentou baixar por HTTP um job que já estava no bucket")
	return "", 0, errors.New("não deveria")
}

// A ordem de precedência do título é a decisão que molda todo upload: as tags
// do arquivo ganham do nome do arquivo, porque um álbum etiquetado não deve
// virar "01 - Faixa". Mas um arquivo SEM tag tem de usar o nome em vez de
// virar "sem título".
func TestTagDoArquivoGanhaDoNomeEnviadoMasONomeSalvaOSemTag(t *testing.T) {
	exigirFFmpeg(t)
	w, jobs, tracks, s3, dono := montar(t, &baixadorQueNaoDeveriaSerChamado{t: t})
	ctx := context.Background()

	comTag, err := os.ReadFile(mp3DeTeste(t, "Nome Da Tag", "Artista Da Tag", false))
	require.NoError(t, err)
	semTag, err := os.ReadFile(mp3DeTeste(t, "", "", false))
	require.NoError(t, err)

	casos := []struct {
		envio    string
		bytes    []byte
		esperado string
	}{
		{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", comTag, "Nome Da Tag"},
		{"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", semTag, "01 - Faixa Sem Tag"},
	}
	for _, c := range casos {
		s3.semear(storage.KeyUploadStage(dono, c.envio), "audio/mpeg", c.bytes, time.Now())
		_, _, err := jobs.EnfileirarEnvio(ctx, dono, acervo.FonteUpload(c.envio), "", "", "01 - Faixa Sem Tag")
		require.NoError(t, err)
	}
	_, err = w.Rodar(ctx)
	require.NoError(t, err)

	faixas, err := tracks.Listar(ctx, dono)
	require.NoError(t, err)
	require.Len(t, faixas, 2)
	titulos := []string{faixas[0].Title, faixas[1].Title}
	require.Contains(t, titulos, "Nome Da Tag", "a tag do arquivo deveria ganhar do nome enviado")
	require.Contains(t, titulos, "01 - Faixa Sem Tag", "sem tag, o nome do arquivo salva do \"sem título\"")
}

// E um título escolhido explicitamente continua ganhando de tudo.
func TestTituloEscolhidoGanhaDaTagEDaReserva(t *testing.T) {
	exigirFFmpeg(t)
	w, jobs, tracks, s3, dono := montar(t, &baixadorQueNaoDeveriaSerChamado{t: t})
	ctx := context.Background()

	bytesMP3, err := os.ReadFile(mp3DeTeste(t, "Nome Da Tag", "", false))
	require.NoError(t, err)
	envio := "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	s3.semear(storage.KeyUploadStage(dono, envio), "audio/mpeg", bytesMP3, time.Now())

	_, _, err = jobs.EnfileirarEnvio(ctx, dono, acervo.FonteUpload(envio), "Eu Escolhi", "", "nome-do-arquivo")
	require.NoError(t, err)
	_, err = w.Rodar(ctx)
	require.NoError(t, err)

	faixas, err := tracks.Listar(ctx, dono)
	require.NoError(t, err)
	require.Len(t, faixas, 1)
	require.Equal(t, "Eu Escolhi", faixas[0].Title)
}

func TestEnvioPelaPWAEhLidoDoBucketEDepoisApagado(t *testing.T) {
	exigirFFmpeg(t)
	w, jobs, tracks, s3, dono := montar(t, &baixadorQueNaoDeveriaSerChamado{t: t})
	ctx := context.Background()

	bytesMP3, err := os.ReadFile(mp3DeTeste(t, "Enviada do Celular", "Eu Mesmo", false))
	require.NoError(t, err)
	envio := "11111111-1111-4111-8111-111111111111"
	stage := storage.KeyUploadStage(dono, envio)
	s3.semear(stage, "application/octet-stream", bytesMP3, time.Now())

	job, _, err := jobs.Enfileirar(ctx, dono, acervo.FonteUpload(envio), "", "")
	require.NoError(t, err)
	_, err = w.Rodar(ctx)
	require.NoError(t, err)

	depois, err := jobs.PorID(ctx, dono, job.ID)
	require.NoError(t, err)
	require.Equal(t, "ready", depois.Status, "erro: %s", depois.Error)

	faixas, err := tracks.Listar(ctx, dono)
	require.NoError(t, err)
	require.Len(t, faixas, 1)
	// O tipo vale o que o ffprobe disse, não o que o navegador mandou no PUT.
	require.Equal(t, "audio/mpeg", faixas[0].AudioType)
	require.Equal(t, "Enviada do Celular", faixas[0].Title)

	// A área de espera foi limpa: os bytes já estão no objeto definitivo.
	require.False(t, s3.tem(stage), "o arquivo cru deveria ter sido apagado")
	require.True(t, s3.tem(faixas[0].AudioKey))
}

func TestEnvioQueNaoChegouAoBucketFalhaComMensagemClara(t *testing.T) {
	w, jobs, _, _, dono := montar(t, &baixadorQueNaoDeveriaSerChamado{t: t})
	ctx := context.Background()

	job, _, err := jobs.Enfileirar(ctx, dono, acervo.FonteUpload("22222222-2222-4222-8222-222222222222"), "", "")
	require.NoError(t, err)
	for i := 0; i < acervo.MaxTentativas; i++ {
		_, err = w.Rodar(ctx)
		require.NoError(t, err)
	}

	depois, err := jobs.PorID(ctx, dono, job.ID)
	require.NoError(t, err)
	require.Equal(t, "error", depois.Status)
	require.Contains(t, depois.Error, "não está mais no bucket")
}

// O worker monta a key com o `user_id` do JOB. Então um job do usuário A não
// alcança a área de espera do usuário B nem quando o id do envio é o mesmo —
// é a autorização estando na derivação da key, não numa checagem que alguém
// possa esquecer de escrever.
func TestWorkerSoLeDaAreaDoDonoDoJob(t *testing.T) {
	exigirFFmpeg(t)
	w, jobs, _, s3, dono := montar(t, &baixadorQueNaoDeveriaSerChamado{t: t})
	ctx := context.Background()

	outro := "99999999-9999-4999-8999-999999999999" // outro usuário, mesmo envio
	envio := "33333333-3333-4333-8333-333333333333"
	bytesMP3, err := os.ReadFile(mp3DeTeste(t, "Do Outro", "", false))
	require.NoError(t, err)
	s3.semear(storage.KeyUploadStage(outro, envio), "audio/mpeg", bytesMP3, time.Now())

	job, _, err := jobs.Enfileirar(ctx, dono, acervo.FonteUpload(envio), "", "")
	require.NoError(t, err)
	_, err = w.Rodar(ctx)
	require.NoError(t, err)

	depois, err := jobs.PorID(ctx, dono, job.ID)
	require.NoError(t, err)
	require.NotEqual(t, "ready", depois.Status, "não deveria ter ingerido arquivo de outro dono")
	// E falhou pelo motivo certo: procurou na área DO DONO DO JOB e não achou
	// nada. Sem esta asserção, o teste passaria mesmo se tivesse falhado por
	// qualquer outra razão.
	require.Contains(t, depois.Error, "não está mais no bucket")
	// E o arquivo do outro continua lá, intocado.
	require.True(t, s3.tem(storage.KeyUploadStage(outro, envio)))
}

// A URL assinada do PUT vale 15 minutos: o arquivo pode ser TROCADO por um
// maior depois do `finalizar` ter conferido o tamanho. O worker reconfere.
func TestEnvioTrocadoPorArquivoMaiorEhRecusadoPeloWorker(t *testing.T) {
	w, jobs, _, s3, dono := montarComTeto(t, &baixadorQueNaoDeveriaSerChamado{t: t}, 1<<10)
	ctx := context.Background()

	envio := "44444444-4444-4444-8444-444444444444"
	s3.semear(storage.KeyUploadStage(dono, envio), "audio/mpeg", make([]byte, 4<<10), time.Now())

	job, _, err := jobs.Enfileirar(ctx, dono, acervo.FonteUpload(envio), "", "")
	require.NoError(t, err)
	for i := 0; i < acervo.MaxTentativas; i++ {
		_, err = w.Rodar(ctx)
		require.NoError(t, err)
	}

	depois, err := jobs.PorID(ctx, dono, job.ID)
	require.NoError(t, err)
	require.Equal(t, "error", depois.Status)
	require.Contains(t, depois.Error, "maior que o limite")
}

func TestVarreduraApagaAbandonadoEPoupaORecenteEOAcervo(t *testing.T) {
	w, _, _, s3, dono := montar(t, &baixadorQueNaoDeveriaSerChamado{t: t})
	ctx := context.Background()

	velho := storage.KeyUploadStage(dono, "55555555-5555-4555-8555-555555555555")
	recente := storage.KeyUploadStage(dono, "66666666-6666-4666-8666-666666666666")
	faixa := "u/" + dono + "/a/alguma.mp3"
	s3.semear(velho, "audio/mpeg", []byte("x"), time.Now().Add(-worker.IdadeAbandono-time.Hour))
	s3.semear(recente, "audio/mpeg", []byte("x"), time.Now())
	// Uma faixa antiga do acervo, para provar que a varredura não passeia
	// fora da área de espera.
	s3.semear(faixa, "audio/mpeg", []byte("x"), time.Now().Add(-30*24*time.Hour))

	n, err := w.VarrerAbandonados(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, n)
	require.False(t, s3.tem(velho), "o abandonado deveria ter saído")
	require.True(t, s3.tem(recente), "envio recente pode estar em andamento")
	require.True(t, s3.tem(faixa), "a varredura não deve tocar no acervo")
}
