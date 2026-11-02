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
	"github.com/thiagotn/ondas/api/internal/config"
	"github.com/thiagotn/ondas/api/internal/dbtest"
	"github.com/thiagotn/ondas/api/internal/playlists"
)

func pedir(t *testing.T, metodo, caminho, corpo string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(metodo, caminho, strings.NewReader(corpo))
	req.Header.Set("Content-Type", "application/json")
	return req
}

// playlistsDe lê a resposta das CINCO rotas, que têm o mesmo formato: a coleção
// inteira que ficou.
func playlistsDe(t *testing.T, w *httptest.ResponseRecorder) []playlists.Playlist {
	t.Helper()
	var corpo struct {
		Playlists []playlists.Playlist `json:"playlists"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &corpo), w.Body.String())
	return corpo.Playlists
}

// criar devolve o id da playlist nova, para os testes não repetirem o parse.
func criar(t *testing.T, r http.Handler, cfg *config.Config, user, nome string) string {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, pedir(t, http.MethodPost, "/api/playlists",
		fmt.Sprintf(`{"nome":%q}`, nome)), user))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	for _, p := range playlistsDe(t, w) {
		if p.Nome == nome {
			return p.ID
		}
	}
	t.Fatalf("playlist %q não voltou na resposta: %s", nome, w.Body.String())
	return ""
}

func TestCriarPlaylistEListar(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	id := criar(t, r, cfg, eu, "Treino")
	require.NotEmpty(t, id)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/playlists", nil), eu))
	require.Equal(t, http.StatusOK, w.Code)
	todas := playlistsDe(t, w)
	require.Len(t, todas, 1)
	require.Equal(t, "Treino", todas[0].Nome)
	// `[]` e nunca `null`: a PWA trata os dois como vazio, mas só um é o
	// contrato escrito.
	require.NotNil(t, todas[0].Itens)
	require.Empty(t, todas[0].Itens)
	require.Contains(t, w.Body.String(), `"itens":[]`)
}

// O nome é o que a pessoa lê no seletor; dois iguais são indistinguíveis ali.
func TestNomeRepetidoNaMesmaContaEConflito(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	outra := dbtest.CriarUsuario(t, pool, "outra@exemplo.test")

	criar(t, r, cfg, eu, "Treino")

	// Maiúscula não cria uma segunda: o índice é por `lower(nome)`.
	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, pedir(t, http.MethodPost, "/api/playlists",
		`{"nome":"treino"}`), eu))
	require.Equal(t, http.StatusConflict, w.Code, w.Body.String())

	// Mas em OUTRA conta o mesmo nome é livre: o índice é por (user_id, nome).
	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, pedir(t, http.MethodPost, "/api/playlists",
		`{"nome":"Treino"}`), outra))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
}

func TestNomeInvalidoNaoCriaPlaylist(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	casos := []string{
		`{"nome":""}`,
		`{"nome":"   "}`,
		// Caractere de controle quebraria em duas a linha do prompt, que
		// imprime o nome cru.
		`{"nome":"tre\nino"}`,
		fmt.Sprintf(`{"nome":%q}`, strings.Repeat("a", playlists.MaxNome+1)),
	}
	for _, corpo := range casos {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, comCookie(t, cfg, pedir(t, http.MethodPost, "/api/playlists", corpo), eu))
		require.Equal(t, http.StatusBadRequest, w.Code, corpo)
	}
}

// A mesma faixa duas vezes na mesma playlist é o MESMO item: é o que a PK diz,
// e é o que faz um pedido reenviado pelo celular não duplicar a linha.
func TestAdicionarAMesmaFaixaDuasVezesNaoDuplica(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	id := criar(t, r, cfg, eu, "Treino")

	for range 2 {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, comCookie(t, cfg, pedir(t, http.MethodPatch,
			"/api/playlists/"+id+"/itens", `{"add":["demo1","demo2"]}`), eu))
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		todas := playlistsDe(t, w)
		require.Len(t, todas, 1)
		require.Equal(t, []string{"demo1", "demo2"}, todas[0].Itens)
	}
}

// A ordem é escolha, e ela tem de sobreviver à releitura — é o que o `J`/`K` da
// tela depende para não voltar atrás no próximo boot.
func TestOrdemReescrevePosESobreviveAReleitura(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	id := criar(t, r, cfg, eu, "Treino")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, pedir(t, http.MethodPatch,
		"/api/playlists/"+id+"/itens", `{"add":["a","b","c"]}`), eu))
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, []string{"a", "b", "c"}, playlistsDe(t, w)[0].Itens)

	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, pedir(t, http.MethodPatch,
		"/api/playlists/"+id+"/itens", `{"ordem":["c","a","b"]}`), eu))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, []string{"c", "a", "b"}, playlistsDe(t, w)[0].Itens)

	// A releitura é a prova: sem reescrever `pos`, a resposta acima poderia
	// estar certa e o banco errado.
	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/playlists", nil), eu))
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, []string{"c", "a", "b"}, playlistsDe(t, w)[0].Itens)
}

// A tela manda a lista que ela tem, e ela pode estar um segundo atrasada em
// relação a outra aba. Id que não é item não pode derrubar o pedido.
func TestOrdemComIdQueNaoEItemEIgnorada(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	id := criar(t, r, cfg, eu, "Treino")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, pedir(t, http.MethodPatch,
		"/api/playlists/"+id+"/itens", `{"add":["a","b"]}`), eu))
	require.Equal(t, http.StatusOK, w.Code)

	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, pedir(t, http.MethodPatch,
		"/api/playlists/"+id+"/itens", `{"ordem":["b","fantasma","a"]}`), eu))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, []string{"b", "a"}, playlistsDe(t, w)[0].Itens)
}

// Tirar e pôr no mesmo pedido: é o que a barra de seleção faz dentro de uma
// playlist.
func TestRemoverEAdicionarNoMesmoPedido(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	id := criar(t, r, cfg, eu, "Treino")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, pedir(t, http.MethodPatch,
		"/api/playlists/"+id+"/itens", `{"add":["a","b"]}`), eu))
	require.Equal(t, http.StatusOK, w.Code)

	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, pedir(t, http.MethodPatch,
		"/api/playlists/"+id+"/itens", `{"add":["c"],"remove":["a"]}`), eu))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, []string{"b", "c"}, playlistsDe(t, w)[0].Itens)

	// Tirar o que não está lá não é erro — é o caso normal de um pedido que
	// subiu duas vezes.
	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, pedir(t, http.MethodPatch,
		"/api/playlists/"+id+"/itens", `{"remove":["a"]}`), eu))
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, []string{"b", "c"}, playlistsDe(t, w)[0].Itens)
}

func TestOMesmoIdEmAddERemoveERecusado(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	id := criar(t, r, cfg, eu, "Treino")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, pedir(t, http.MethodPatch,
		"/api/playlists/"+id+"/itens", `{"add":["a"],"remove":["a"]}`), eu))
	require.Equal(t, http.StatusBadRequest, w.Code)
}

// Para quem não é dono, a playlist não existe: 404 e nunca 403, a régua de
// `acervo.PorID`. Um 403 confirmaria que aquele id é de alguém.
func TestPlaylistDeOutraContaNaoExiste(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	outra := dbtest.CriarUsuario(t, pool, "outra@exemplo.test")
	id := criar(t, r, cfg, eu, "Treino")

	casos := []*http.Request{
		pedir(t, http.MethodPatch, "/api/playlists/"+id, `{"nome":"roubada"}`),
		pedir(t, http.MethodDelete, "/api/playlists/"+id, ``),
		pedir(t, http.MethodPatch, "/api/playlists/"+id+"/itens", `{"add":["a"]}`),
	}
	for _, req := range casos {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, comCookie(t, cfg, req, outra))
		require.Equal(t, http.StatusNotFound, w.Code, req.Method+" "+req.URL.Path)
	}

	// E a listagem da outra conta não a enxerga.
	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/playlists", nil), outra))
	require.Equal(t, http.StatusOK, w.Code)
	require.Empty(t, playlistsDe(t, w))
}

func TestIdQueNaoEUuidDaQuatrocentosEQuatro(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, pedir(t, http.MethodPatch,
		"/api/playlists/nao-e-uuid/itens", `{"add":["a"]}`), eu))
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestApagarPlaylistLevaOsItens(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	id := criar(t, r, cfg, eu, "Treino")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, pedir(t, http.MethodPatch,
		"/api/playlists/"+id+"/itens", `{"add":["a","b"]}`), eu))
	require.Equal(t, http.StatusOK, w.Code)

	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, pedir(t, http.MethodDelete, "/api/playlists/"+id, ``), eu))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Empty(t, playlistsDe(t, w))

	// A FK para `playlists` é o que leva os itens junto, sem código.
	var sobrou int
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT count(*) FROM playlist_items`).Scan(&sobrou))
	require.Zero(t, sobrou)
}

// A faixa apagada do acervo tem de sair das playlists. `playlist_items` não tem
// FK para `tracks` (migração 0008), então quem faz isso é `removerFaixa` à mão
// — tirar aquela linha de lá é o que este teste existe para denunciar.
func TestApagarFaixaDoAcervoTiraOItemDaPlaylist(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	faixa := "11111111-1111-4111-8111-111111111111"
	_, err := acervo.NewTracks(pool).Criar(context.Background(), acervo.Nova{
		ID: faixa, UserID: eu, Title: "minha", Artist: "a", Genre: "acervo", DurS: 10,
		AudioKey: "u/eu/a/1.mp3", AudioType: "audio/mpeg", SizeBytes: 1,
	})
	require.NoError(t, err)

	id := criar(t, r, cfg, eu, "Treino")
	w := httptest.NewRecorder()
	// O id vai PREFIXADO, porque é assim que ele chega ao navegador e é assim
	// que a faixa entra na playlist.
	r.ServeHTTP(w, comCookie(t, cfg, pedir(t, http.MethodPatch,
		"/api/playlists/"+id+"/itens",
		`{"add":["acervo:`+faixa+`","demo1"]}`), eu))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Len(t, playlistsDe(t, w)[0].Itens, 2)

	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg,
		httptest.NewRequest(http.MethodDelete, "/api/acervo/"+faixa, nil), eu))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/playlists", nil), eu))
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, []string{"demo1"}, playlistsDe(t, w)[0].Itens,
		"a faixa apagada do acervo continuou contando como item da playlist")
}

func TestTetoDePlaylistsPorConta(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	for i := range playlists.MaxPorConta {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, comCookie(t, cfg, pedir(t, http.MethodPost, "/api/playlists",
			fmt.Sprintf(`{"nome":"p%d"}`, i)), eu))
		require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, pedir(t, http.MethodPost, "/api/playlists",
		`{"nome":"a-que-nao-cabe"}`), eu))
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestTetoDeItensPorPlaylist(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	id := criar(t, r, cfg, eu, "Treino")

	ids := make([]string, 0, playlists.MaxItens+1)
	for i := range playlists.MaxItens + 1 {
		ids = append(ids, fmt.Sprintf(`"f%d"`, i))
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, pedir(t, http.MethodPatch,
		"/api/playlists/"+id+"/itens",
		`{"add":[`+strings.Join(ids, ",")+`]}`), eu))
	require.Equal(t, http.StatusBadRequest, w.Code)

	// E nada foi aplicado: a transação inteira voltou atrás.
	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/playlists", nil), eu))
	require.Empty(t, playlistsDe(t, w)[0].Itens)
}

// A régua que divide as rotas: o token de máquina do Hermes existe para entrar
// com faixa nova, e organizar a biblioteca de alguém não é isso. Mover estas
// rotas para um grupo com token compila e passa no resto da suíte; só este
// teste denuncia.
func TestPlaylistsExigemSessaoENaoAceitamToken(t *testing.T) {
	r, pool, _ := montar(t, true)
	dbtest.CriarUsuario(t, pool, "dono@exemplo.test")

	const umID = "33333333-3333-4333-8333-333333333333"
	casos := []struct{ metodo, caminho, corpo string }{
		{http.MethodGet, "/api/playlists", ""},
		{http.MethodPost, "/api/playlists", `{"nome":"do-bot"}`},
		{http.MethodPatch, "/api/playlists/" + umID, `{"nome":"x"}`},
		{http.MethodDelete, "/api/playlists/" + umID, ""},
		{http.MethodPatch, "/api/playlists/" + umID + "/itens", `{"add":["a"]}`},
	}
	for _, c := range casos {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, pedir(t, c.metodo, c.caminho, c.corpo))
		require.Equal(t, http.StatusUnauthorized, w.Code, "sem cookie: "+c.caminho)

		req := pedir(t, c.metodo, c.caminho, c.corpo)
		req.Header.Set("X-Ondas-Token", tokenDoBot)
		w = httptest.NewRecorder()
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusUnauthorized, w.Code, "com token: "+c.caminho)
	}
}
