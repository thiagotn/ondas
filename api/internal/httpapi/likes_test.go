package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/thiagotn/ondas/api/internal/acervo"
	"github.com/thiagotn/ondas/api/internal/dbtest"
)

func patchLikes(t *testing.T, corpo string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPatch, "/api/likes", strings.NewReader(corpo))
	req.Header.Set("Content-Type", "application/json")
	return req
}

// idsDe lê a resposta das duas rotas de curtida, que têm o mesmo formato.
func idsDe(t *testing.T, w *httptest.ResponseRecorder) []string {
	t.Helper()
	var corpo struct {
		IDs []string `json:"ids"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &corpo))
	return corpo.IDs
}

func TestCurtirDuasVezesNaoCriaDuasLinhas(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	// Curtir o que já está curtido é o caso NORMAL de uma fila que subiu duas
	// vezes (a primeira tentativa venceu, a resposta se perdeu). Não é erro.
	for range 2 {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, comCookie(t, cfg, patchLikes(t, `{"add":["demo1"],"remove":[]}`), eu))
		require.Equal(t, http.StatusOK, w.Code)
		require.Equal(t, []string{"demo1"}, idsDe(t, w))
	}

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/likes", nil), eu))
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, []string{"demo1"}, idsDe(t, w))
}

func TestDescurtirOQueNaoEstaCurtidoNaoEErro(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, patchLikes(t, `{"add":[],"remove":["nunca-curtida"]}`), eu))
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, []string{}, idsDe(t, w), "lista vazia é [] e não null")
}

// A resposta é a coleção INTEIRA, não o delta que subiu. É isso que deixa o
// cliente aplicar o resultado direto no store sem uma segunda leitura que
// possa discordar da escrita — o mesmo contrato de `Users.DefinirPublico`.
func TestARespostaEAColecaoInteiraENaoODelta(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, patchLikes(t, `{"add":["a","b","c"],"remove":[]}`), eu))
	require.Equal(t, http.StatusOK, w.Code)
	require.ElementsMatch(t, []string{"a", "b", "c"}, idsDe(t, w))

	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, patchLikes(t, `{"add":["d"],"remove":["b"]}`), eu))
	require.Equal(t, http.StatusOK, w.Code)
	require.ElementsMatch(t, []string{"a", "c", "d"}, idsDe(t, w))
}

func TestCurtidaDeUmDonoNaoApareceParaOOutro(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	outro := dbtest.CriarUsuario(t, pool, "outro@exemplo.test")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, patchLikes(t, `{"add":["minha"],"remove":[]}`), eu))
	require.Equal(t, http.StatusOK, w.Code)

	// O mesmo id curtido pelos dois são DUAS linhas, e cada um descurtir a sua
	// não mexe na do outro — é o que a PK composta garante.
	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, patchLikes(t, `{"add":["minha","dele"],"remove":[]}`), outro))
	require.Equal(t, http.StatusOK, w.Code)

	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, patchLikes(t, `{"add":[],"remove":["minha"]}`), outro))
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, []string{"dele"}, idsDe(t, w))

	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/likes", nil), eu))
	require.Equal(t, []string{"minha"}, idsDe(t, w), "a curtida do outro não encostou na minha")
}

// Curtida é da conta, e só a sessão a muda. Mesma divisão de
// `TestPrefsExigeSessaoENaoAceitaToken`: mover esta rota para um grupo com
// token compila e passa no resto da suíte; só este teste denuncia.
func TestCurtidasExigemSessaoENaoAceitamToken(t *testing.T) {
	r, pool, _ := montar(t, true)
	dbtest.CriarUsuario(t, pool, "dono@exemplo.test")

	for _, req := range []*http.Request{
		httptest.NewRequest(http.MethodGet, "/api/likes", nil),
		patchLikes(t, `{"add":["x"],"remove":[]}`),
	} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusUnauthorized, w.Code, "sem cookie não passa")
	}

	for _, req := range []*http.Request{
		httptest.NewRequest(http.MethodGet, "/api/likes", nil),
		patchLikes(t, `{"add":["x"],"remove":[]}`),
	} {
		req.Header.Set("X-Ondas-Token", tokenDoBot)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusUnauthorized, w.Code, "o token do bot não mexe em curtida")
	}
}

func TestPedidoDeCurtidaForaDoTetoNaoPassa(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	muitos := make([]string, maxIDsPorPedido+1)
	for i := range muitos {
		muitos[i] = fmt.Sprintf("id%d", i)
	}
	corpo, err := json.Marshal(map[string]any{"add": muitos, "remove": []string{}})
	require.NoError(t, err)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, patchLikes(t, string(corpo)), eu))
	require.Equal(t, http.StatusBadRequest, w.Code, "a lista tem teto")

	// Id vazio e id gigante também não entram: a coluna é `text`, e sem isto
	// ela vira depósito.
	for _, ruim := range []string{`{"add":[""],"remove":[]}`,
		`{"add":["` + strings.Repeat("x", maxTamanhoID+1) + `"],"remove":[]}`} {
		w = httptest.NewRecorder()
		r.ServeHTTP(w, comCookie(t, cfg, patchLikes(t, ruim), eu))
		require.Equal(t, http.StatusBadRequest, w.Code)
	}
}

// A adoção das curtidas que já estavam no aparelho sobe TODAS de uma vez, e
// isso passa folgado dos 4 KiB do `lerJSON` padrão. Sem `lerJSONAte` a
// resposta seria "requisição inválida" para um pedido perfeitamente válido.
func TestAColecaoInteiraCabeNoCorpoDoPedido(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	muitos := make([]string, 500)
	for i := range muitos {
		muitos[i] = fmt.Sprintf("acervo:11111111-1111-4111-8111-%012d", i)
	}
	corpo, err := json.Marshal(map[string]any{"add": muitos, "remove": []string{}})
	require.NoError(t, err)
	require.Greater(t, len(corpo), 4<<10, "o teste só vale se o corpo passar dos 4 KiB")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, patchLikes(t, string(corpo)), eu))
	require.Equal(t, http.StatusOK, w.Code)
	require.Len(t, idsDe(t, w), 500)
}

// Sem FK, ninguém apaga a curtida da faixa que deixou de existir — então o
// handler apaga. E apaga pelo id PREFIXADO, que é como ela foi curtida.
func TestApagarFaixaDoAcervoApagaACurtidaDela(t *testing.T) {
	r, pool, cfg := montar(t, true)
	ctx := context.Background()
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	const id = "11111111-1111-4111-8111-111111111111"
	_, err := acervo.NewTracks(pool).Criar(ctx, acervo.Nova{
		ID: id, UserID: eu, Title: "minha", Artist: "a", Genre: "acervo", DurS: 10,
		AudioKey: "u/eu/a/1.mp3", AudioType: "audio/mpeg", SizeBytes: 1,
	})
	require.NoError(t, err)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, patchLikes(t, `{"add":["acervo:`+id+`","demo1"],"remove":[]}`), eu))
	require.Equal(t, http.StatusOK, w.Code)

	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg,
		httptest.NewRequest(http.MethodDelete, "/api/acervo/"+id, nil), eu))
	require.Equal(t, http.StatusOK, w.Code)

	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/likes", nil), eu))
	require.Equal(t, []string{"demo1"}, idsDe(t, w), "a curtida da faixa apagada saiu junto")
}

// `ON DELETE CASCADE`: apagar a conta não pode deixar curtida para trás.
func TestApagarAContaLevaAsCurtidasJunto(t *testing.T) {
	r, pool, cfg := montar(t, true)
	ctx := context.Background()
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, patchLikes(t, `{"add":["demo1","demo2"],"remove":[]}`), eu))
	require.Equal(t, http.StatusOK, w.Code)

	_, err := pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, eu)
	require.NoError(t, err)

	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM likes`).Scan(&n))
	require.Zero(t, n)
}

// As respostas de curtida não podem entrar em cache do edge, pelo mesmo motivo
// do acervo: elas são de uma sessão só.
func TestRespostasDeCurtidaNaoEntramEmCache(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/likes", nil), eu))
	require.Equal(t, "private, no-store", w.Header().Get("Cache-Control"))
}
