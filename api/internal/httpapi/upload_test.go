package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/thiagotn/ondas/api/internal/acervo"
	"github.com/thiagotn/ondas/api/internal/config"
	"github.com/thiagotn/ondas/api/internal/dbtest"
)

// bucketFalso é o mínimo de S3 que o `finalizar` precisa: responder HEAD com
// um tamanho, 404 quando o objeto não chegou, e registrar o DELETE — porque
// parte do contrato é que um envio recusado SAI do bucket na hora, em vez de
// esperar a varredura de 24h.
type bucketFalso struct {
	mu       sync.Mutex
	tamanhos map[string]int64
	apagados []string
}

func novoBucket() *bucketFalso {
	return &bucketFalso{tamanhos: map[string]int64{}}
}

func (b *bucketFalso) semear(key string, tamanho int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.tamanhos[key] = tamanho
}

func (b *bucketFalso) foiApagado(key string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, k := range b.apagados {
		if k == key {
			return true
		}
	}
	return false
}

func (b *bucketFalso) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.URL.Path, "/ondas-acervo/")
		b.mu.Lock()
		tamanho, existe := b.tamanhos[key]
		b.mu.Unlock()

		switch r.Method {
		case http.MethodHead, http.MethodGet:
			if !existe {
				w.Header().Set("Content-Type", "application/xml")
				w.WriteHeader(http.StatusNotFound)
				_, _ = fmt.Fprintf(w, `<Error><Code>NoSuchKey</Code><Key>%s</Key></Error>`, key)
				return
			}
			w.Header().Set("Content-Length", strconv.FormatInt(tamanho, 10))
			// O S3 real sempre manda Last-Modified, e o minio se recusa a
			// interpretar um Stat sem ele — o dublê tem de mandar também.
			w.Header().Set("Last-Modified", time.Now().UTC().Format(http.TimeFormat))
			w.Header().Set("ETag", `"x"`)
			w.WriteHeader(http.StatusOK)
		case http.MethodDelete:
			b.mu.Lock()
			delete(b.tamanhos, key)
			b.apagados = append(b.apagados, key)
			b.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusOK)
		}
	}
}

// montarComBucket é como `montar`, mas com um S3 que responde de verdade.
func montarComBucket(t *testing.T, b *bucketFalso) (http.Handler, *pgxpool.Pool, *config.Config) {
	t.Helper()
	pool := dbtest.Pool(t)
	cfg := &config.Config{
		SessionSecret:     "segredo-de-teste",
		SessionMaxAgeS:    3600,
		SessionCookie:     "ondas_session",
		SessionInsecure:   true,
		LoginAttempts:     8,
		LoginWindowS:      300,
		R2Bucket:          "ondas-acervo",
		R2SignedURLTTLS:   3600,
		IngestTokenSHA256: somaDoToken(tokenDoBot),
		IngestUserEmail:   "dono@exemplo.test",
		IngestMaxMB:       10,
	}
	srv := New(cfg, pool)
	s3 := httptest.NewServer(b.handler())
	t.Cleanup(s3.Close)
	u, err := url.Parse(s3.URL)
	require.NoError(t, err)
	srv.r2 = r2DeTeste(t, u.Host)
	return srv.Router(), pool, cfg
}

func postJSON(t *testing.T, r http.Handler, cfg *config.Config, caminho, corpo, userID string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, caminho, strings.NewReader(corpo))
	req.Header.Set("Content-Type", "application/json")
	if userID != "" {
		req = comCookie(t, cfg, req, userID)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

// postComToken é o postJSON do chamador de máquina: header de token e nenhum
// cookie. Existe desde a skill do SoundCloud, que envia arquivo sem sessão.
func postComToken(t *testing.T, r http.Handler, caminho, corpo, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, caminho, strings.NewReader(corpo))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Ondas-Token", token)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

// --- vaga de upload ---

func TestVagaDeUploadAssinaUmPUTNaAreaDoProprioDono(t *testing.T) {
	r, pool, cfg := montarComBucket(t, novoBucket())
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	rec := postJSON(t, r, cfg, "/api/acervo/upload", `{"bytes":1024}`, eu)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var vaga vagaJSON
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &vaga))
	require.NotEmpty(t, vaga.ID)
	require.Equal(t, int64(10<<20), vaga.MaxBytes)
	require.Positive(t, vaga.ExpiraEmS)

	u, err := url.Parse(vaga.URL)
	require.NoError(t, err)
	// A key tem o dono DA SESSÃO: não há parâmetro que o cliente possa mandar
	// para assinar um PUT na área de outra pessoa.
	require.Equal(t, "/ondas-acervo/stage/"+eu+"/"+vaga.ID+".bin", u.Path)
	// E é uma URL assinada de verdade, não o endereço cru do objeto.
	require.NotEmpty(t, u.Query().Get("X-Amz-Signature"))
	require.NotEmpty(t, u.Query().Get("X-Amz-Expires"))
}

func TestVagaDeUploadRecusaArquivoMaiorQueOTetoAntesDoEnvio(t *testing.T) {
	r, pool, cfg := montarComBucket(t, novoBucket())
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	rec := postJSON(t, r, cfg, "/api/acervo/upload", `{"bytes":20971520}`, eu)
	require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
	require.Contains(t, rec.Body.String(), "10 MB")
}

func TestVagaDeUploadExigeTamanho(t *testing.T) {
	r, pool, cfg := montarComBucket(t, novoBucket())
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	rec := postJSON(t, r, cfg, "/api/acervo/upload", `{"bytes":0}`, eu)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

// O token passou a entrar aqui com a skill do SoundCloud: o node baixa a faixa
// e precisa de uma porta para o acervo. Este teste já afirmou o CONTRÁRIO (401)
// e estava certo enquanto o único a enviar arquivo era o navegador.
//
// O que substitui o 401 como garantia é a área: o token não escolhe de quem é
// a key — ela sai do usuário autenticado, que no caminho do token é sempre o
// `INGEST_USER_EMAIL`.
func TestVagaDeUploadPeloTokenAssinaNaAreaDoDonoConfigurado(t *testing.T) {
	r, pool, _ := montarComBucket(t, novoBucket())
	dono := dbtest.CriarUsuario(t, pool, "dono@exemplo.test") // o IngestUserEmail

	rec := postComToken(t, r, "/api/acervo/upload", `{"bytes":1024}`, tokenDoBot)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var vaga vagaJSON
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &vaga))
	u, err := url.Parse(vaga.URL)
	require.NoError(t, err)
	require.Equal(t, "/ondas-acervo/stage/"+dono+"/"+vaga.ID+".bin", u.Path)
	require.NotEmpty(t, u.Query().Get("X-Amz-Signature"))
}

// A rota nova herda a validação do token. Sem este teste, uma troca de
// middleware que aceitasse qualquer header passaria sem ninguém notar.
func TestVagaDeUploadRecusaTokenErrado(t *testing.T) {
	r, pool, _ := montarComBucket(t, novoBucket())
	dbtest.CriarUsuario(t, pool, "dono@exemplo.test")

	for _, ruim := range []string{tokenDoBot + "x", strings.ToUpper(tokenDoBot), " " + tokenDoBot, "errado"} {
		rec := postComToken(t, r, "/api/acervo/upload", `{"bytes":1024}`, ruim)
		require.Equal(t, http.StatusUnauthorized, rec.Code, "token %q não deveria entrar", ruim)
	}
}

func TestVagaDeUploadSemCookieNemTokenNaoAbre(t *testing.T) {
	r, _, _ := montarComBucket(t, novoBucket())

	rec := postJSON(t, r, nil, "/api/acervo/upload", `{"bytes":1024}`, "")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.Contains(t, rec.Body.String(), "sessão expirada")
}

// --- finalizar ---

func TestFinalizarEnfileiraAIngestaoDoArquivoQueChegou(t *testing.T) {
	b := novoBucket()
	r, pool, cfg := montarComBucket(t, b)
	ctx := context.Background()
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	rec := postJSON(t, r, cfg, "/api/acervo/upload", `{"bytes":2048}`, eu)
	require.Equal(t, http.StatusOK, rec.Code)
	var vaga vagaJSON
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &vaga))
	b.semear("stage/"+eu+"/"+vaga.ID+".bin", 2048)

	rec = postJSON(t, r, cfg, "/api/acervo/upload/"+vaga.ID+"/finalizar",
		`{"title":"Do Celular","artist":"Eu"}`, eu)
	require.Equal(t, http.StatusAccepted, rec.Code, rec.Body.String())

	var job jobJSON
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &job))
	require.Equal(t, "pending", job.Status)

	// O job guarda o ID do envio, não a key: é o worker que monta a key com o
	// dono do job (ver worker.origem).
	guardado, err := acervo.NewJobs(pool).PorID(ctx, eu, job.ID)
	require.NoError(t, err)
	require.Equal(t, acervo.FonteUpload(vaga.ID), guardado.SourceURL)
	require.Equal(t, "Do Celular", guardado.Title)

	// E dá para acompanhar pela mesma rota da ingestão por URL.
	req := comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/acervo/ingest/"+job.ID, nil), eu)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
}

func TestFinalizarResponde404QuandoOArquivoNaoChegou(t *testing.T) {
	r, pool, cfg := montarComBucket(t, novoBucket())
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	rec := postJSON(t, r, cfg, "/api/acervo/upload", `{"bytes":2048}`, eu)
	var vaga vagaJSON
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &vaga))

	rec = postJSON(t, r, cfg, "/api/acervo/upload/"+vaga.ID+"/finalizar", `{}`, eu)
	require.Equal(t, http.StatusNotFound, rec.Code)
	require.Contains(t, rec.Body.String(), "não chegou ao bucket")
}

// A URL assinada não limita bytes: quem mentiu no pedido da vaga é pego aqui,
// com o tamanho real — e o arquivo sai do bucket na hora.
func TestFinalizarRecusaEApagaArquivoMaiorQueOTeto(t *testing.T) {
	b := novoBucket()
	r, pool, cfg := montarComBucket(t, b)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	rec := postJSON(t, r, cfg, "/api/acervo/upload", `{"bytes":1024}`, eu)
	var vaga vagaJSON
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &vaga))
	key := "stage/" + eu + "/" + vaga.ID + ".bin"
	b.semear(key, 50<<20)

	rec = postJSON(t, r, cfg, "/api/acervo/upload/"+vaga.ID+"/finalizar", `{}`, eu)
	require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
	require.True(t, b.foiApagado(key), "o arquivo recusado deveria sair do bucket na hora")
}

func TestFinalizarVazioEhRecusado(t *testing.T) {
	b := novoBucket()
	r, pool, cfg := montarComBucket(t, b)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	rec := postJSON(t, r, cfg, "/api/acervo/upload", `{"bytes":1024}`, eu)
	var vaga vagaJSON
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &vaga))
	key := "stage/" + eu + "/" + vaga.ID + ".bin"
	b.semear(key, 0)

	rec = postJSON(t, r, cfg, "/api/acervo/upload/"+vaga.ID+"/finalizar", `{}`, eu)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.True(t, b.foiApagado(key))
}

func TestFinalizarDuasVezesNaoCriaDoisJobs(t *testing.T) {
	b := novoBucket()
	r, pool, cfg := montarComBucket(t, b)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	rec := postJSON(t, r, cfg, "/api/acervo/upload", `{"bytes":2048}`, eu)
	var vaga vagaJSON
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &vaga))
	b.semear("stage/"+eu+"/"+vaga.ID+".bin", 2048)

	primeiro := postJSON(t, r, cfg, "/api/acervo/upload/"+vaga.ID+"/finalizar", `{}`, eu)
	require.Equal(t, http.StatusAccepted, primeiro.Code)
	segundo := postJSON(t, r, cfg, "/api/acervo/upload/"+vaga.ID+"/finalizar", `{}`, eu)
	// 200, não 202: nada novo foi aceito — o job de antes continua valendo.
	require.Equal(t, http.StatusOK, segundo.Code)

	var a, c jobJSON
	require.NoError(t, json.Unmarshal(primeiro.Body.Bytes(), &a))
	require.NoError(t, json.Unmarshal(segundo.Body.Bytes(), &c))
	require.Equal(t, a.ID, c.ID)
}

// O caminho completo do node do Hermes: vaga e finalizar só com token.
//
// As duas asserções do fim são o que trava a decisão de precedência de título:
// a skill NÃO manda `title`, para as tags que o scdl escreveu ganharem, e manda
// o nome do arquivo como reserva. Sem isto, alguém "conserta" a skill mandando
// título e um álbum etiquetado volta a virar "01 - Faixa".
func TestFinalizarPeloTokenEnfileiraNoAcervoDoDono(t *testing.T) {
	b := novoBucket()
	r, pool, _ := montarComBucket(t, b)
	ctx := context.Background()
	dono := dbtest.CriarUsuario(t, pool, "dono@exemplo.test")

	rec := postComToken(t, r, "/api/acervo/upload", `{"bytes":2048}`, tokenDoBot)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var vaga vagaJSON
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &vaga))
	b.semear("stage/"+dono+"/"+vaga.ID+".bin", 2048)

	rec = postComToken(t, r, "/api/acervo/upload/"+vaga.ID+"/finalizar",
		`{"nome":"Artista - Faixa.mp3"}`, tokenDoBot)
	require.Equal(t, http.StatusAccepted, rec.Code, rec.Body.String())

	var job jobJSON
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &job))
	guardado, err := acervo.NewJobs(pool).PorID(ctx, dono, job.ID)
	require.NoError(t, err)
	require.Equal(t, acervo.FonteUpload(vaga.ID), guardado.SourceURL)
	require.Empty(t, guardado.Title, "a skill não manda título: as tags do arquivo têm de ganhar")
	require.Equal(t, "Artista - Faixa.mp3", guardado.TituloReserva)
}

// Compartilhar o id de envio não basta: o token resolve para outro usuário,
// logo para outra key. É o mesmo recorte do teste de sessão abaixo, pelo outro
// caminho de autenticação.
func TestTokenNaoAlcancaOEnvioDeOutroDono(t *testing.T) {
	b := novoBucket()
	r, pool, cfg := montarComBucket(t, b)
	dbtest.CriarUsuario(t, pool, "dono@exemplo.test")
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	rec := postJSON(t, r, cfg, "/api/acervo/upload", `{"bytes":2048}`, eu)
	var vaga vagaJSON
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &vaga))
	alheio := "stage/" + eu + "/" + vaga.ID + ".bin"
	b.semear(alheio, 2048)

	rec = postComToken(t, r, "/api/acervo/upload/"+vaga.ID+"/finalizar", `{}`, tokenDoBot)
	require.Equal(t, http.StatusNotFound, rec.Code)
	require.False(t, b.foiApagado(alheio), "o envio do outro não pode ser tocado")
}

// A área de espera de outro dono é inalcançável: a key vem do usuário
// autenticado, então o mesmo id de envio em duas contas aponta para dois
// objetos diferentes.
func TestFinalizarNaoAlcancaOEnvioDeOutroDono(t *testing.T) {
	b := novoBucket()
	r, pool, cfg := montarComBucket(t, b)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	outro := dbtest.CriarUsuario(t, pool, "outro@exemplo.test")

	rec := postJSON(t, r, cfg, "/api/acervo/upload", `{"bytes":2048}`, outro)
	var vaga vagaJSON
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &vaga))
	alheio := "stage/" + outro + "/" + vaga.ID + ".bin"
	b.semear(alheio, 2048)

	rec = postJSON(t, r, cfg, "/api/acervo/upload/"+vaga.ID+"/finalizar", `{}`, eu)
	require.Equal(t, http.StatusNotFound, rec.Code)
	require.False(t, b.foiApagado(alheio), "e o arquivo do outro não pode ser tocado")
}

// A fonte `upload:` é interna: nasce só de um envio que o próprio dono fez.
//
// O token hoje alcança essa fonte, pelo `finalizar` — mas com a key derivada
// do usuário autenticado. O que este teste guarda é a outra metade: `/ingest`
// continua admitindo só http(s), então não há como pedir ao worker que leia uma
// key arbitrária do bucket passando um `source_url` fabricado.
func TestIngestNaoAceitaFonteDeUpload(t *testing.T) {
	r, pool, cfg := montarComBucket(t, novoBucket())
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	for _, fonte := range []string{"upload:abc", "r2://ondas-acervo/u/x/a.mp3", "file:///etc/passwd"} {
		rec := postJSON(t, r, cfg, "/api/acervo/ingest", `{"url":"`+fonte+`"}`, eu)
		require.Equal(t, http.StatusBadRequest, rec.Code, "fonte %q deveria ser recusada", fonte)
		require.Contains(t, rec.Body.String(), "http(s)")
	}
}
