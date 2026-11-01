package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/thiagotn/ondas/api/internal/acervo"
	"github.com/thiagotn/ondas/api/internal/auth"
	"github.com/thiagotn/ondas/api/internal/config"
	"github.com/thiagotn/ondas/api/internal/dbtest"
	"github.com/thiagotn/ondas/api/internal/ingest"
	"github.com/thiagotn/ondas/api/internal/storage"
)

const tokenDoBot = "token-de-teste-do-bot"

func r2DeTeste(t *testing.T, host string) *storage.R2 {
	t.Helper()
	r2, err := storage.NewComEndpoint(host, false, "chave", "segredo", "ondas-acervo", time.Hour)
	require.NoError(t, err)
	return r2
}

func novasSessoesDeTeste(cfg *config.Config) *auth.Sessions {
	return auth.NewSessions(cfg.SessionSecret, time.Duration(cfg.SessionMaxAgeS)*time.Second)
}

func somaDoToken(token string) string {
	s := sha256.Sum256([]byte(token))
	return hex.EncodeToString(s[:])
}

// montar sobe o roteador inteiro contra um Postgres real e um S3 falso. É
// deliberadamente integrado: o que se quer provar aqui — recorte por dono,
// 302 com assinatura, os dois caminhos de autenticação — mora na costura, não
// dentro de uma função isolada.
func montar(t *testing.T, comR2 bool) (http.Handler, *pgxpool.Pool, *config.Config) {
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
	}
	srv := New(cfg, pool)
	if comR2 {
		s3 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		}))
		t.Cleanup(s3.Close)
		u, err := url.Parse(s3.URL)
		require.NoError(t, err)
		srv.r2 = r2DeTeste(t, u.Host)
	}
	return srv.Router(), pool, cfg
}

func comCookie(t *testing.T, cfg *config.Config, req *http.Request, userID string) *http.Request {
	t.Helper()
	sess := novasSessoesDeTeste(cfg)
	req.AddCookie(&http.Cookie{Name: cfg.SessionCookie, Value: sess.Sign(userID)})
	return req
}

func TestAcervoSoMostraAsFaixasDoDono(t *testing.T) {
	r, pool, cfg := montar(t, true)
	ctx := context.Background()
	tracks := acervo.NewTracks(pool)

	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	outro := dbtest.CriarUsuario(t, pool, "outro@exemplo.test")
	_, err := tracks.Criar(ctx, acervo.Nova{
		ID: "11111111-1111-4111-8111-111111111111", UserID: eu,
		Title: "minha", Artist: "a", Genre: "acervo", DurS: 10,
		AudioKey: "u/eu/a/1.mp3", AudioType: "audio/mpeg", SizeBytes: 1,
	})
	require.NoError(t, err)
	_, err = tracks.Criar(ctx, acervo.Nova{
		ID: "22222222-2222-4222-8222-222222222222", UserID: outro,
		Title: "dele", Artist: "b", Genre: "acervo", DurS: 10,
		AudioKey: "u/outro/a/2.mp3", AudioType: "audio/mpeg", SizeBytes: 1,
	})
	require.NoError(t, err)

	req := comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/acervo", nil), eu)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	var corpo struct{ Tracks []map[string]any }
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &corpo))
	require.Len(t, corpo.Tracks, 1)
	require.Equal(t, "minha", corpo.Tracks[0]["title"])

	// O formato é o do Track do core, para a fase 3 não precisar de tradutor.
	require.Equal(t, "acervo:11111111-1111-4111-8111-111111111111", corpo.Tracks[0]["id"])
	require.Equal(t, "/api/acervo/11111111-1111-4111-8111-111111111111/audio", corpo.Tracks[0]["stream"])
	// premium EXPLÍCITO: `undefined` faria a PWA cair no heurístico do
	// protótipo e marcar música própria como [pro].
	require.Equal(t, false, corpo.Tracks[0]["premium"])
	// Sem capa, nada de URL de capa.
	require.Equal(t, "", corpo.Tracks[0]["art"])
	require.NotContains(t, corpo.Tracks[0], "artThumb")
	// Sem forma de onda medida, o campo não vai: é assim que a PWA sabe que
	// deve desenhar barra lisa em vez de inventar relevo.
	require.NotContains(t, corpo.Tracks[0], "peaks")
}

func TestFormaDeOndaSaiNoCatalogo(t *testing.T) {
	r, pool, cfg := montar(t, true)
	ctx := context.Background()
	tracks := acervo.NewTracks(pool)

	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	picos := strings.Repeat("Qa", ingest.PicosPorFaixa/2)
	_, err := tracks.Criar(ctx, acervo.Nova{
		ID: "33333333-3333-4333-8333-333333333333", UserID: eu,
		Title: "com forma", Artist: "a", Genre: "acervo", DurS: 10,
		AudioKey: "u/eu/a/3.mp3", AudioType: "audio/mpeg", SizeBytes: 1,
		Peaks: picos,
	})
	require.NoError(t, err)

	req := comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/acervo", nil), eu)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	var corpo struct{ Tracks []map[string]any }
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &corpo))
	require.Len(t, corpo.Tracks, 1)
	require.Equal(t, picos, corpo.Tracks[0]["peaks"])
}

func TestAudioRedirecionaParaURLAssinada(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	id := "33333333-3333-4333-8333-333333333333"
	_, err := acervo.NewTracks(pool).Criar(context.Background(), acervo.Nova{
		ID: id, UserID: eu, Title: "x", Artist: "y", Genre: "acervo", DurS: 10,
		AudioKey: "u/eu/a/3.mp3", AudioType: "audio/mpeg", SizeBytes: 1,
	})
	require.NoError(t, err)

	req := comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/acervo/"+id+"/audio", nil), eu)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusFound, w.Code)
	loc := w.Header().Get("Location")
	require.Contains(t, loc, "u/eu/a/3.mp3")
	require.Contains(t, loc, "X-Amz-Signature")
	// O redirect carrega assinatura com prazo: cacheá-lo entregaria a URL a
	// outra sessão.
	require.Contains(t, w.Header().Get("Cache-Control"), "no-store")
}

func TestFaixaDeOutroDonoDaQuatrocentosEQuatro(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	outro := dbtest.CriarUsuario(t, pool, "outro@exemplo.test")
	id := "44444444-4444-4444-8444-444444444444"
	_, err := acervo.NewTracks(pool).Criar(context.Background(), acervo.Nova{
		ID: id, UserID: outro, Title: "dele", Artist: "y", Genre: "acervo", DurS: 10,
		AudioKey: "u/outro/a/4.mp3", AudioType: "audio/mpeg", SizeBytes: 1,
	})
	require.NoError(t, err)

	for _, caminho := range []string{"/api/acervo/" + id + "/audio", "/api/acervo/" + id + "/art"} {
		req := comCookie(t, cfg, httptest.NewRequest(http.MethodGet, caminho, nil), eu)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusNotFound, w.Code, caminho)
		// Nem um Location vazando a key do outro.
		require.Empty(t, w.Header().Get("Location"))
	}

	req := comCookie(t, cfg, httptest.NewRequest(http.MethodDelete, "/api/acervo/"+id, nil), eu)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusNotFound, w.Code)
}

// Id que não é uuid faria o pgx devolver erro de sintaxe; a resposta certa é
// 404, não 500.
func TestIdQueNaoEhUUIDDaQuatrocentosEQuatro(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	req := comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/acervo/nao-e-uuid/audio", nil), eu)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestSemCookieNemTokenOAcervoNaoAbre(t *testing.T) {
	r, _, _ := montar(t, true)
	for _, caminho := range []string{"/api/acervo", "/api/acervo/x/audio"} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, caminho, nil))
		require.Equal(t, http.StatusUnauthorized, w.Code, caminho)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/acervo/ingest",
		strings.NewReader(`{"url":"https://exemplo.test/a.mp3"}`)))
	require.Equal(t, http.StatusUnauthorized, w.Code)
}

// Sem credencial de R2 o acervo responde 503 — mas o login continua de pé.
func TestSemR2OAcervoResponde503EOLoginSegue(t *testing.T) {
	r, pool, cfg := montar(t, false)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	req := comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/acervo", nil), eu)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusServiceUnavailable, w.Code)

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/healthz", nil))
	require.Equal(t, http.StatusOK, w.Code)

	req = comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/auth/me", nil), eu)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code, "o login não depende do R2")
}

// O escopo do token, rota por rota. É documentação executável da divisão de
// grupos do roteador: mover uma rota de um grupo para o outro compila e passa
// em todo o resto da suíte — só este teste denuncia.
func TestEscopoDoTokenNoAcervo(t *testing.T) {
	r, pool, _ := montar(t, true)
	dbtest.CriarUsuario(t, pool, "dono@exemplo.test")

	casos := []struct {
		metodo, caminho string
		// entra: o token é aceito pela autenticação (o status final pode ser
		// 404 ou 400; o que importa é não ser 401).
		entra bool
	}{
		// Entrar com faixa nova: o node do Hermes precisa das quatro.
		{http.MethodPost, "/api/acervo/ingest", true},
		{http.MethodGet, "/api/acervo/ingest/33333333-3333-4333-8333-333333333333", true},
		{http.MethodPost, "/api/acervo/upload", true},
		{http.MethodPost, "/api/acervo/upload/33333333-3333-4333-8333-333333333333/finalizar", true},
		// Mexer no acervo que já existe: nenhuma. É aqui que um token vazado
		// viraria exfiltração ou destruição.
		{http.MethodGet, "/api/acervo", false},
		{http.MethodGet, "/api/acervo/33333333-3333-4333-8333-333333333333/audio", false},
		{http.MethodGet, "/api/acervo/33333333-3333-4333-8333-333333333333/art", false},
		{http.MethodDelete, "/api/acervo/33333333-3333-4333-8333-333333333333", false},
		// O bot escolhe o destino da faixa que ele mesmo traz (`para`, no corpo
		// do ingest), mas mudar com quem uma faixa JÁ EXISTENTE é dividida é
		// mexer no acervo — e para isso o token não serve.
		{http.MethodPatch, "/api/acervo/33333333-3333-4333-8333-333333333333/compartilhamento", false},
	}

	for _, c := range casos {
		corpo := strings.NewReader(`{"url":"https://exemplo.test/a.mp3","bytes":1024}`)
		req := httptest.NewRequest(c.metodo, c.caminho, corpo)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Ondas-Token", tokenDoBot)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if c.entra {
			require.NotEqual(t, http.StatusUnauthorized, w.Code,
				"%s %s deveria aceitar o token", c.metodo, c.caminho)
			continue
		}
		require.Equal(t, http.StatusUnauthorized, w.Code,
			"%s %s NÃO deveria aceitar o token", c.metodo, c.caminho)
	}
}

// E o negativo com dados de verdade: com uma faixa existente no banco, um 401
// não pode ser confundido com um 404 de id inexistente.
func TestTokenNaoAlcancaOAcervoQueJaExiste(t *testing.T) {
	b := novoBucket()
	r, pool, _ := montarComBucket(t, b)
	ctx := context.Background()
	dono := dbtest.CriarUsuario(t, pool, "dono@exemplo.test")

	id := "44444444-4444-4444-8444-444444444444"
	audioKey := "u/" + dono + "/a/" + id + ".mp3"
	tracks := acervo.NewTracks(pool)
	_, err := tracks.Criar(ctx, acervo.Nova{
		ID: id, UserID: dono, Title: "Minha", Artist: "Eu", Genre: "acervo", DurS: 10,
		AudioKey: audioKey, AudioType: "audio/mpeg", SizeBytes: 1,
	})
	require.NoError(t, err)
	b.semear(audioKey, 1)

	for _, c := range []struct{ metodo, caminho string }{
		{http.MethodGet, "/api/acervo"},
		{http.MethodGet, "/api/acervo/" + id + "/audio"},
		{http.MethodGet, "/api/acervo/" + id + "/art"},
		{http.MethodDelete, "/api/acervo/" + id},
	} {
		req := httptest.NewRequest(c.metodo, c.caminho, nil)
		req.Header.Set("X-Ondas-Token", tokenDoBot)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusUnauthorized, w.Code, "%s %s", c.metodo, c.caminho)
	}

	// E nada passou nem pela metade: a faixa está no banco e o objeto no bucket.
	_, err = tracks.PorID(ctx, dono, id)
	require.NoError(t, err, "o DELETE por token não pode ter apagado a linha")
	require.False(t, b.foiApagado(audioKey), "nem o objeto")
}

func TestBotIngerePorToken(t *testing.T) {
	r, pool, _ := montar(t, true)
	dono := dbtest.CriarUsuario(t, pool, "dono@exemplo.test")

	req := httptest.NewRequest(http.MethodPost, "/api/acervo/ingest",
		strings.NewReader(`{"url":"https://exemplo.test/musica.mp3","title":"Minha"}`))
	req.Header.Set("X-Ondas-Token", tokenDoBot)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())
	var job map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &job))
	require.Equal(t, "pending", job["status"])

	// A faixa é do dono configurado, não de ninguém mais.
	var userID string
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT user_id FROM ingest_jobs WHERE id = $1`, job["id"]).Scan(&userID))
	require.Equal(t, dono, userID)
}

// Reenvio é esperado (o Telegram repete a entrega): o segundo pedido não cria
// ingestão nova e diz isso com 200 em vez de 202.
func TestReenvioDaMesmaURLResponde200(t *testing.T) {
	r, pool, _ := montar(t, true)
	dbtest.CriarUsuario(t, pool, "dono@exemplo.test")

	pedir := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/acervo/ingest",
			strings.NewReader(`{"url":"https://exemplo.test/musica.mp3"}`))
		req.Header.Set("X-Ondas-Token", tokenDoBot)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w
	}
	primeiro := pedir()
	require.Equal(t, http.StatusAccepted, primeiro.Code)
	segundo := pedir()
	require.Equal(t, http.StatusOK, segundo.Code)

	var a, b map[string]any
	require.NoError(t, json.Unmarshal(primeiro.Body.Bytes(), &a))
	require.NoError(t, json.Unmarshal(segundo.Body.Bytes(), &b))
	require.Equal(t, a["id"], b["id"])
}

func TestTokenErradoNaoEntra(t *testing.T) {
	r, pool, _ := montar(t, true)
	dbtest.CriarUsuario(t, pool, "dono@exemplo.test")

	for _, token := range []string{
		"errado",
		tokenDoBot + "x",
		strings.ToUpper(tokenDoBot),
		" " + tokenDoBot,
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/acervo/ingest",
			strings.NewReader(`{"url":"https://exemplo.test/a.mp3"}`))
		req.Header.Set("X-Ondas-Token", token)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusUnauthorized, w.Code, "token %q não devia entrar", token)
	}
}

// Token correto mas sem a conta do dono no banco: 401, não 500.
func TestTokenSemDonoCadastradoNaoEntra(t *testing.T) {
	r, _, _ := montar(t, true)

	req := httptest.NewRequest(http.MethodPost, "/api/acervo/ingest",
		strings.NewReader(`{"url":"https://exemplo.test/a.mp3"}`))
	req.Header.Set("X-Ondas-Token", tokenDoBot)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestURLSemEsquemaHTTPEhRecusada(t *testing.T) {
	r, pool, _ := montar(t, true)
	dbtest.CriarUsuario(t, pool, "dono@exemplo.test")

	for _, corpo := range []string{
		`{"url":"file:///etc/passwd"}`,
		`{"url":""}`,
		`{"url":"   "}`,
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/acervo/ingest", strings.NewReader(corpo))
		req.Header.Set("X-Ondas-Token", tokenDoBot)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusBadRequest, w.Code, corpo)
	}
}

func TestStatusDaIngestaoPeloToken(t *testing.T) {
	r, pool, _ := montar(t, true)
	dono := dbtest.CriarUsuario(t, pool, "dono@exemplo.test")
	job, _, err := acervo.NewJobs(pool).Enfileirar(context.Background(), dono,
		"https://exemplo.test/a.mp3", "", "", acervo.Destino{})
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodGet, "/api/acervo/ingest/"+job.ID, nil)
	req.Header.Set("X-Ondas-Token", tokenDoBot)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	corpo, err := io.ReadAll(w.Body)
	require.NoError(t, err)
	var saida map[string]any
	require.NoError(t, json.Unmarshal(corpo, &saida))
	require.Equal(t, job.ID, saida["id"])
	require.Equal(t, "pending", saida["status"])
}

func TestRespostasDoAcervoNaoEntramEmCache(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	req := comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/acervo", nil), eu)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Contains(t, w.Header().Get("Cache-Control"), "no-store")
}
