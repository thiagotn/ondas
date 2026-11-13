package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/thiagotn/ondas/api/internal/auth"
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

	// A aparência entra pela mesma rota e vale a mesma regra.
	req = patchPrefs(t, `{"prefs":{"tema":"nord"}}`)
	req.Header.Set("X-Ondas-Token", tokenDoBot)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusUnauthorized, w.Code, "nem na aparência dela")
}

// meDe lê o `/me` desta conta, já decodificado.
func meDe(t *testing.T, r http.Handler, req *http.Request) map[string]any {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	var corpo map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &corpo))
	return corpo
}

func TestPrefsGuardaAAparenciaEOMeConcorda(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	me := func() map[string]any {
		return meDe(t, r, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/auth/me", nil), eu))
	}

	// Conta que nunca escolheu traz o objeto VAZIO, e não a chave ausente: é a
	// presença dela que diz à PWA que este servidor guarda preferências. E vazio
	// de verdade — um padrão aqui apagaria o tema do primeiro aparelho a abrir.
	require.Equal(t, map[string]any{}, me()["prefs"])

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg,
		patchPrefs(t, `{"prefs":{"tema":"nord","opacity":0.55,"blur":12,"wall":"imagem"}}`), eu))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var corpo map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &corpo))
	esperado := map[string]any{"tema": "nord", "opacity": 0.55, "blur": float64(12), "wall": "imagem"}
	require.Equal(t, esperado, corpo["prefs"], "a resposta já traz o que ficou")
	// 0.55 volta 0.55: com `real` no lugar de `double precision` voltaria
	// 0.550000011920929, e o cliente veria uma diferença eterna.
	require.Equal(t, esperado, me()["prefs"])

	// O segundo pedido mexe em OUTRO campo e não apaga os primeiros: é o que
	// deixa dois aparelhos mudarem coisas diferentes sem se atropelar.
	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, patchPrefs(t, `{"prefs":{"idioma":"es"}}`), eu))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	esperado["idioma"] = "es"
	require.Equal(t, esperado, me()["prefs"])
}

func TestPrefsDaAparenciaEDoCatalogoNaoSeAtropelam(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	me := func() map[string]any {
		return meDe(t, r, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/auth/me", nil), eu))
	}

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, patchPrefs(t, `{"publico":false}`), eu))
	require.Equal(t, http.StatusOK, w.Code)

	// Só a aparência: o catálogo continua desligado. Com um `bool` no UPDATE em
	// vez de `COALESCE`, este pedido o religaria.
	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, patchPrefs(t, `{"prefs":{"tema":"dracula"}}`), eu))
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, false, me()["publico"])

	// E só o catálogo: o tema continua lá.
	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, patchPrefs(t, `{"publico":true}`), eu))
	require.Equal(t, http.StatusOK, w.Code)
	agora := me()
	require.Equal(t, true, agora["publico"])
	require.Equal(t, map[string]any{"tema": "dracula"}, agora["prefs"])

	// Os dois no mesmo pedido valem juntos.
	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, patchPrefs(t, `{"publico":false,"prefs":{"blur":0}}`), eu))
	require.Equal(t, http.StatusOK, w.Code)
	agora = me()
	require.Equal(t, false, agora["publico"])
	// `blur: 0` é um valor, não ausência: com `omitempty` num `int16` em vez de
	// ponteiro ele sumiria da resposta.
	require.Equal(t, map[string]any{"tema": "dracula", "blur": float64(0)}, agora["prefs"])
}

func TestPrefsRecusaAparenciaForaDaFaixa(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	for _, corpo := range []string{
		`{"prefs":{}}`,                    // não mexe em nada
		`{"prefs":{"opacity":0.1}}`,       // abaixo do slider
		`{"prefs":{"opacity":1.5}}`,       // acima
		`{"prefs":{"blur":41}}`,           // acima
		`{"prefs":{"blur":-1}}`,           // abaixo
		`{"prefs":{"blur":12.5}}`,         // não é inteiro
		`{"prefs":{"wall":"foto"}}`,       // fora do enum
		`{"prefs":{"tema":"com espaco"}}`, // forma
		`{"prefs":{"tema":""}}`,           // vazio não é "apaga"
		`{"prefs":{"tema":"` + strings.Repeat("a", 33) + `"}}`,
		`{"prefs":{"idioma":"portugues_br"}}`,                 // forma
		`{"prefs":{"wallImg":"data:image/jpeg;base64,AAAA"}}`, // a imagem não sobe
		// Um campo bom não carrega um ruim: nada do pedido é gravado.
		`{"prefs":{"tema":"nord","blur":99}}`,
	} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, comCookie(t, cfg, patchPrefs(t, corpo), eu))
		require.Equal(t, http.StatusBadRequest, w.Code, corpo)
	}

	me := meDe(t, r, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/auth/me", nil), eu))
	require.Equal(t, map[string]any{}, me["prefs"], "nenhum dos pedidos recusados deixou rastro")
}

func TestLoginDevolveAAparenciaDaConta(t *testing.T) {
	r, pool, cfg := montar(t, true)
	// Pelo repositório, e não por `dbtest.CriarUsuario`: aquele grava um hash de
	// mentira, e este teste precisa de uma senha que o login aceite.
	const senha = "senha-de-teste"
	eu, err := auth.NewUsers(pool).Create(context.Background(),
		auth.Nova{Email: "eu@exemplo.test", Senha: senha, Status: auth.StatusAprovada})
	require.NoError(t, err)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, patchPrefs(t, `{"prefs":{"tema":"nord","idioma":"en"}}`), eu.ID))
	require.Equal(t, http.StatusOK, w.Code)

	// É no login que o segundo aparelho fica sabendo: se só o `/me` trouxesse,
	// ele abriria no padrão e trocaria de tema um boot depois.
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login",
		strings.NewReader(`{"email":"eu@exemplo.test","password":"`+senha+`"}`))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var corpo map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &corpo))
	require.Equal(t, map[string]any{"tema": "nord", "idioma": "en"}, corpo["prefs"])
}
