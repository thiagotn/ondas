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

// O token do bot ingere URL; escrever objeto no bucket não é função dele.
func TestVagaDeUploadNaoAceitaOTokenDoBot(t *testing.T) {
	r, _, _ := montarComBucket(t, novoBucket())

	req := httptest.NewRequest(http.MethodPost, "/api/acervo/upload", strings.NewReader(`{"bytes":1024}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Ondas-Token", tokenDoBot)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
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

// A área de espera de outro dono é inalcançável: a key vem da sessão, então
// o mesmo id de envio em duas contas aponta para dois objetos diferentes.
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

// A fonte `upload:` é interna. A rota de ingestão — a única que aceita o token
// de máquina — só admite http(s), então o bot não tem como pedir ao worker que
// leia uma key qualquer do bucket.
func TestIngestNaoAceitaFonteDeUpload(t *testing.T) {
	r, pool, cfg := montarComBucket(t, novoBucket())
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	for _, fonte := range []string{"upload:abc", "r2://ondas-acervo/u/x/a.mp3", "file:///etc/passwd"} {
		rec := postJSON(t, r, cfg, "/api/acervo/ingest", `{"url":"`+fonte+`"}`, eu)
		require.Equal(t, http.StatusBadRequest, rec.Code, "fonte %q deveria ser recusada", fonte)
		require.Contains(t, rec.Body.String(), "http(s)")
	}
}
