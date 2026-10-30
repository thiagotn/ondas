package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/thiagotn/ondas/api/internal/dbtest"
)

func patchPrefs(t *testing.T, corpo string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPatch, "/api/auth/prefs", strings.NewReader(corpo))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func TestPrefsDesligaOCatalogoPublicoEOMeConcorda(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	// Conta nova nasce ligada (`DEFAULT true` da migração 0005).
	req := comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/auth/me", nil), eu)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	var corpo map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &corpo))
	require.Equal(t, true, corpo["publico"])

	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, patchPrefs(t, `{"publico":false}`), eu))
	require.Equal(t, http.StatusOK, w.Code)
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &corpo))
	require.Equal(t, false, corpo["publico"], "a resposta já traz o valor novo")

	// A ida e volta pelo /me é o que prova que gravou: é por ele que a PWA
	// decide a fonte do catálogo no boot seguinte, inclusive em outro aparelho.
	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/auth/me", nil), eu))
	require.Equal(t, http.StatusOK, w.Code)
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &corpo))
	require.Equal(t, false, corpo["publico"])
}

func TestPrefsSemAChaveNaoDesligaNada(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	// `{}` é pedido inválido, não "desliga". Com um `bool` em vez de ponteiro
	// no handler, isto responderia 200 e apagaria o catálogo de quem só mandou
	// um JSON errado.
	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, patchPrefs(t, `{}`), eu))
	require.Equal(t, http.StatusBadRequest, w.Code)

	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/auth/me", nil), eu))
	var corpo map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &corpo))
	require.Equal(t, true, corpo["publico"], "continua como estava")
}

// A preferência é da conta, e só a sessão a muda. O token de máquina do Hermes
// entra com faixa nova e nada mais — é a mesma divisão de
// `TestEscopoDoTokenNoAcervo`, e aqui ela vale por `exigirSessao` nem olhar o
// header. Mover esta rota para um grupo com token compila e passa no resto da
// suíte; só este teste denuncia.
func TestPrefsExigeSessaoENaoAceitaToken(t *testing.T) {
	r, pool, _ := montar(t, true)
	dbtest.CriarUsuario(t, pool, "dono@exemplo.test")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, patchPrefs(t, `{"publico":false}`))
	require.Equal(t, http.StatusUnauthorized, w.Code, "sem cookie não passa")

	req := patchPrefs(t, `{"publico":false}`)
	req.Header.Set("X-Ondas-Token", tokenDoBot)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusUnauthorized, w.Code, "o token do bot não mexe em conta")
}
