package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/thiagotn/ondas/api/internal/acervo"
	"github.com/thiagotn/ondas/api/internal/auth"
	"github.com/thiagotn/ondas/api/internal/config"
	"github.com/thiagotn/ondas/api/internal/dbtest"
)

const tokenDoAdmin = "token-de-teste-do-admin"

const senhaDeTeste = "senha-de-teste"

func comAdmin(req *http.Request) *http.Request {
	req.Header.Set(cabecalhoAdmin, tokenDoAdmin)
	return req
}

func corpoDe(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var corpo map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &corpo), w.Body.String())
	return corpo
}

func pedirConta(t *testing.T, r http.Handler, email string) *httptest.ResponseRecorder {
	t.Helper()
	return servir(r, pedidoJSON(t, http.MethodPost, "/api/auth/signup",
		`{"name":"Fulana","email":"`+email+`","password":"`+senhaDeTeste+`","mensagem":"quero testar"}`))
}

func entrar(t *testing.T, r http.Handler, email, senha string) *httptest.ResponseRecorder {
	t.Helper()
	return servir(r, pedidoJSON(t, http.MethodPost, "/api/auth/login",
		`{"email":"`+email+`","password":"`+senha+`"}`))
}

func idDaContaPorEmail(t *testing.T, pool *pgxpool.Pool, email string) string {
	t.Helper()
	var id string
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT id FROM users WHERE email = $1`, email).Scan(&id))
	return id
}

// contaComSenha cria, pelo repositório, uma conta aprovada com senha de verdade
// — `dbtest.CriarUsuario` grava um hash de mentira, que o login não aceita.
func contaComSenha(t *testing.T, pool *pgxpool.Pool, email string) string {
	t.Helper()
	u, err := auth.NewUsers(pool).Create(context.Background(),
		auth.Nova{Email: email, Senha: senhaDeTeste, Status: auth.StatusAprovada})
	require.NoError(t, err)
	return u.ID
}

func montarComAdmin(t *testing.T) (http.Handler, *pgxpool.Pool, *config.Config) {
	t.Helper()
	r, pool, cfg := montar(t, true)
	cfg.SignupOpen = true
	cfg.AdminTokenSHA256 = somaDoToken(tokenDoAdmin)
	return r, pool, cfg
}

func TestCadastroFechadoRecusaOPedido(t *testing.T) {
	r, _, _ := montar(t, true)
	w := pedirConta(t, r, "nova@exemplo.test")
	require.Equal(t, http.StatusForbidden, w.Code)
	require.Equal(t, CodCadastroFechado, corpoDe(t, w)["code"])
}

// O caminho inteiro: pedir, esperar, ser aprovada, entrar.
func TestPedidoFicaEmAnaliseAteOAdminAprovar(t *testing.T) {
	r, pool, _ := montarComAdmin(t)

	w := pedirConta(t, r, "nova@exemplo.test")
	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())
	require.Equal(t, "pendente", corpoDe(t, w)["status"])
	// Pedido não é sessão: sem isto a conta em análise já sairia logada.
	require.Empty(t, w.Result().Cookies(), "o pedido não pode gravar cookie")

	// Quem acerta a senha fica sabendo que está em análise — e não entra.
	w = entrar(t, r, "nova@exemplo.test", senhaDeTeste)
	require.Equal(t, http.StatusForbidden, w.Code)
	require.Equal(t, CodContaEmAnalise, corpoDe(t, w)["code"])
	require.Empty(t, w.Result().Cookies())

	// Quem ERRA a senha não fica sabendo de nada: a resposta é a mesma de um
	// e-mail que nunca pediu conta.
	w = entrar(t, r, "nova@exemplo.test", "senha-errada-123")
	require.Equal(t, http.StatusUnauthorized, w.Code)
	require.Equal(t, CodCredenciaisInvalidas, corpoDe(t, w)["code"])

	// A fila do admin mostra o pedido, com o e-mail e a mensagem.
	w = servir(r, comAdmin(httptest.NewRequest(http.MethodGet, "/api/admin/contas?status=pendente", nil)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var fila struct{ Contas []auth.Conta }
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &fila))
	require.Len(t, fila.Contas, 1)
	require.Equal(t, "nova@exemplo.test", fila.Contas[0].Email)
	require.Equal(t, "Fulana", fila.Contas[0].Name)
	require.Equal(t, "quero testar", fila.Contas[0].Mensagem)
	require.False(t, fila.Contas[0].PodeEnviar)
	require.Nil(t, fila.Contas[0].DecididoEm)

	id := idDaContaPorEmail(t, pool, "nova@exemplo.test")
	w = servir(r, comAdmin(httptest.NewRequest(http.MethodPost, "/api/admin/contas/"+id+"/aprovar", nil)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, "aprovada", corpoDe(t, w)["status"])

	w = entrar(t, r, "nova@exemplo.test", senhaDeTeste)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NotEmpty(t, w.Result().Cookies())
	corpo := corpoDe(t, w)
	require.Equal(t, "Fulana", corpo["name"])
	// A conta aprovada usa a plataforma, e ainda assim não envia arquivo.
	require.Equal(t, false, corpo["podeEnviar"])
}

func TestContaNegadaNaoEntra(t *testing.T) {
	r, pool, _ := montarComAdmin(t)
	require.Equal(t, http.StatusAccepted, pedirConta(t, r, "nova@exemplo.test").Code)
	id := idDaContaPorEmail(t, pool, "nova@exemplo.test")

	w := servir(r, comAdmin(httptest.NewRequest(http.MethodPost, "/api/admin/contas/"+id+"/negar", nil)))
	require.Equal(t, http.StatusOK, w.Code)

	w = entrar(t, r, "nova@exemplo.test", senhaDeTeste)
	require.Equal(t, http.StatusForbidden, w.Code)
	require.Equal(t, CodCadastroNegado, corpoDe(t, w)["code"])

	// E pedir de novo com o mesmo e-mail não reabre a fila.
	require.Equal(t, http.StatusConflict, pedirConta(t, r, "nova@exemplo.test").Code)
}

// Negar uma conta que já estava dentro é como se suspende alguém. O cookie é
// sem estado e continuaria valendo por trinta dias; quem faz a decisão valer é
// o middleware, que relê o status a cada pedido.
func TestNegarDerrubaASessaoQueJaExistia(t *testing.T) {
	r, pool, cfg := montarComAdmin(t)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	me := func() int {
		return servir(r, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/auth/me", nil), eu)).Code
	}
	require.Equal(t, http.StatusOK, me())

	w := servir(r, comAdmin(httptest.NewRequest(http.MethodPost, "/api/admin/contas/"+eu+"/negar", nil)))
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, http.StatusUnauthorized, me(), "o mesmo cookie não pode mais entrar")

	w = servir(r, comAdmin(httptest.NewRequest(http.MethodPost, "/api/admin/contas/"+eu+"/aprovar", nil)))
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, http.StatusOK, me(), "aprovar de novo devolve o acesso")
}

// A allowlist é a decisão do admin tomada de antemão: pula a análise, com o
// cadastro aberto ou fechado.
func TestAllowlistEntraSemAnalise(t *testing.T) {
	r, _, cfg := montar(t, true)
	cfg.SignupAllowlist = "amiga@exemplo.test"

	w := pedirConta(t, r, "Amiga@exemplo.test")
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	require.NotEmpty(t, w.Result().Cookies(), "conta da allowlist já sai logada")
	require.Equal(t, false, corpoDe(t, w)["podeEnviar"], "mas sem envio, como toda conta nova")
}

func TestCadastroRecusaNomeEMensagemInvalidos(t *testing.T) {
	r, _, _ := montarComAdmin(t)

	pedido := func(nome, mensagem string) int {
		corpo, err := json.Marshal(map[string]string{
			"name": nome, "email": "nova@exemplo.test", "password": senhaDeTeste, "mensagem": mensagem,
		})
		require.NoError(t, err)
		return servir(r, pedidoJSON(t, http.MethodPost, "/api/auth/signup", string(corpo))).Code
	}
	require.Equal(t, http.StatusBadRequest, pedido(strings.Repeat("n", auth.NomeMaximo+1), ""))
	require.Equal(t, http.StatusBadRequest, pedido("com\nquebra", ""))
	require.Equal(t, http.StatusBadRequest, pedido("ok", strings.Repeat("m", auth.MensagemMaxima+1)))
	// Sem nome, vale a parte do e-mail antes do `@`, como sempre foi.
	require.Equal(t, http.StatusAccepted, pedido("", ""))
}

func TestCadastroTemFreioPorIP(t *testing.T) {
	r, _, _ := montarComAdmin(t)
	for i := 0; i < 10; i++ {
		// Pedido inválido de propósito: o freio conta a tentativa, e não a
		// conta criada — senão dez argon2 por segundo sairiam de graça.
		servir(r, pedidoJSON(t, http.MethodPost, "/api/auth/signup", `{"email":"x","password":"curta"}`))
	}
	w := pedirConta(t, r, "nova@exemplo.test")
	require.Equal(t, http.StatusTooManyRequests, w.Code)
}

func TestAdminExigeOTokenDeAdmin(t *testing.T) {
	r, pool, cfg := montarComAdmin(t)
	eu := dbtest.CriarUsuario(t, pool, "dono@exemplo.test")
	rotas := []struct{ metodo, caminho string }{
		{http.MethodGet, "/api/admin/contas"},
		{http.MethodPost, "/api/admin/contas/" + eu + "/aprovar"},
		{http.MethodPost, "/api/admin/contas/" + eu + "/negar"},
		{http.MethodPatch, "/api/admin/contas/" + eu + "/envio"},
	}

	// Cada pedido chega de um IP diferente: são dezesseis recusas, e o que este
	// teste olha é a autenticação, não o freio de tentativas (que tem o seu).
	pedidos := 0
	novo := func(metodo, caminho string) *http.Request {
		pedidos++
		req := httptest.NewRequest(metodo, caminho, nil)
		req.Header.Set("CF-Connecting-IP", "203.0.113."+strconv.Itoa(pedidos))
		return req
	}

	for _, c := range rotas {
		// Sem nada.
		w := servir(r, novo(c.metodo, c.caminho))
		require.Equal(t, http.StatusUnauthorized, w.Code, "%s %s sem token", c.metodo, c.caminho)

		// Sessão válida não é admin: não existe papel de admin em `users`.
		w = servir(r, comCookie(t, cfg, novo(c.metodo, c.caminho), eu))
		require.Equal(t, http.StatusUnauthorized, w.Code, "%s %s com cookie", c.metodo, c.caminho)

		// O token do BOT não abre a porta do admin, nem no cabeçalho dele…
		req := novo(c.metodo, c.caminho)
		req.Header.Set("X-Ondas-Token", tokenDoBot)
		require.Equal(t, http.StatusUnauthorized, servir(r, req).Code, "%s %s com token do bot", c.metodo, c.caminho)

		// …nem no do admin.
		req = novo(c.metodo, c.caminho)
		req.Header.Set(cabecalhoAdmin, tokenDoBot)
		require.Equal(t, http.StatusUnauthorized, servir(r, req).Code, "%s %s com token trocado", c.metodo, c.caminho)
	}

	// E o contrário: o token do admin não entra com faixa pelo caminho do bot.
	req := pedidoJSON(t, http.MethodPost, "/api/acervo/ingest", `{"url":"https://exemplo.test/a.mp3"}`)
	req.Header.Set("X-Ondas-Token", tokenDoAdmin)
	require.Equal(t, http.StatusUnauthorized, servir(r, req).Code)
}

// Sem `ADMIN_TOKEN_SHA256` a administração tem de parecer uma rota que não
// existe — inclusive para quem manda um token.
func TestAdminSemTokenConfiguradoNaoExiste(t *testing.T) {
	r, _, _ := montar(t, true)
	w := servir(r, comAdmin(httptest.NewRequest(http.MethodGet, "/api/admin/contas", nil)))
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestAdminTemFreioDeTentativas(t *testing.T) {
	r, _, cfg := montarComAdmin(t)
	for i := 0; i < cfg.LoginAttempts; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/admin/contas", nil)
		req.Header.Set(cabecalhoAdmin, "errado")
		require.Equal(t, http.StatusUnauthorized, servir(r, req).Code)
	}
	// Depois do teto, nem o token certo passa até a janela andar.
	w := servir(r, comAdmin(httptest.NewRequest(http.MethodGet, "/api/admin/contas", nil)))
	require.Equal(t, http.StatusTooManyRequests, w.Code)
}

func TestAdminListaPorStatusEPorEmail(t *testing.T) {
	r, pool, _ := montarComAdmin(t)
	dbtest.CriarUsuario(t, pool, "antiga@exemplo.test")
	require.Equal(t, http.StatusAccepted, pedirConta(t, r, "nova@exemplo.test").Code)

	emails := func(consulta string) []string {
		w := servir(r, comAdmin(httptest.NewRequest(http.MethodGet, "/api/admin/contas"+consulta, nil)))
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		var corpo struct{ Contas []auth.Conta }
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &corpo))
		saida := []string{}
		for _, c := range corpo.Contas {
			saida = append(saida, c.Email)
		}
		return saida
	}
	require.Equal(t, []string{"antiga@exemplo.test", "nova@exemplo.test"}, emails(""))
	require.Equal(t, []string{"nova@exemplo.test"}, emails("?status=pendente"))
	require.Equal(t, []string{"antiga@exemplo.test"}, emails("?status=aprovada"))
	require.Equal(t, []string{}, emails("?status=negada"))
	require.Equal(t, []string{"nova@exemplo.test"}, emails("?email=NOVA@exemplo.test"))
	require.Equal(t, []string{}, emails("?email=ninguem@exemplo.test"))

	w := servir(r, comAdmin(httptest.NewRequest(http.MethodGet, "/api/admin/contas?status=qualquer", nil)))
	require.Equal(t, http.StatusBadRequest, w.Code)

	// Id que não é uuid, e uuid que não é de ninguém: 404 nos dois, nunca 500.
	for _, id := range []string{"nao-e-uuid", "33333333-3333-4333-8333-333333333333"} {
		w = servir(r, comAdmin(httptest.NewRequest(http.MethodPost, "/api/admin/contas/"+id+"/aprovar", nil)))
		require.Equal(t, http.StatusNotFound, w.Code, id)
		require.Equal(t, CodContaNaoEncontrada, corpoDe(t, w)["code"])
	}
}

// O bloqueio do envio, nas três rotas que entram com faixa nova — e a prova de
// que quem já enviava (conta antiga, bot) continua enviando.
func TestContaSemEnvioNaoEntraComFaixa(t *testing.T) {
	r, pool, cfg := montarComAdmin(t)
	// `montar` não define teto de envio, e com zero todo arquivo é grande demais.
	cfg.IngestMaxMB = 60
	dbtest.CriarUsuario(t, pool, "dono@exemplo.test")
	nova := dbtest.CriarUsuario(t, pool, "nova@exemplo.test")
	_, err := pool.Exec(context.Background(), `UPDATE users SET pode_enviar = false WHERE id = $1`, nova)
	require.NoError(t, err)

	entradas := []struct{ caminho, corpo string }{
		{"/api/acervo/ingest", `{"url":"https://exemplo.test/a.mp3"}`},
		{"/api/acervo/upload", `{"bytes":1024}`},
		{"/api/acervo/upload/33333333-3333-4333-8333-333333333333/finalizar", `{"title":"t"}`},
	}
	for _, e := range entradas {
		w := postJSON(t, r, cfg, e.caminho, e.corpo, nova)
		require.Equal(t, http.StatusForbidden, w.Code, e.caminho)
		require.Equal(t, CodEnvioNaoPermitido, corpoDe(t, w)["code"], e.caminho)
	}
	var jobs int
	require.NoError(t, pool.QueryRow(context.Background(), `SELECT count(*) FROM ingest_jobs`).Scan(&jobs))
	require.Zero(t, jobs, "nada pode ter sido enfileirado")

	// Ouvir e listar continuam de pé: o bloqueio é só da entrada.
	w := servir(r, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/acervo", nil), nova))
	require.Equal(t, http.StatusOK, w.Code)

	// O bot segue entrando: o dono dele é uma conta que já enviava.
	w = postComToken(t, r, "/api/acervo/ingest", `{"url":"https://exemplo.test/a.mp3"}`, tokenDoBot)
	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())

	// O admin libera a conta, e a mesma chamada passa.
	w = servir(r, comAdmin(pedidoJSON(t, http.MethodPatch, "/api/admin/contas/"+nova+"/envio", `{"podeEnviar":true}`)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, true, corpoDe(t, w)["podeEnviar"])
	w = postJSON(t, r, cfg, "/api/acervo/upload", `{"bytes":1024}`, nova)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	// `{}` é pedido inválido, e não "desliga".
	w = servir(r, comAdmin(pedidoJSON(t, http.MethodPatch, "/api/admin/contas/"+nova+"/envio", `{}`)))
	require.Equal(t, http.StatusBadRequest, w.Code)
	w = postJSON(t, r, cfg, "/api/acervo/upload", `{"bytes":1024}`, nova)
	require.Equal(t, http.StatusOK, w.Code, "o pedido inválido não pode ter tirado o envio")
}

// Tirar o envio do dono do token tira o do bot: o direito é da conta.
func TestBotPerdeOEnvioComODono(t *testing.T) {
	r, pool, _ := montarComAdmin(t)
	dono := dbtest.CriarUsuario(t, pool, "dono@exemplo.test")

	w := servir(r, comAdmin(pedidoJSON(t, http.MethodPatch, "/api/admin/contas/"+dono+"/envio", `{"podeEnviar":false}`)))
	require.Equal(t, http.StatusOK, w.Code)
	w = postComToken(t, r, "/api/acervo/ingest", `{"url":"https://exemplo.test/a.mp3"}`, tokenDoBot)
	require.Equal(t, http.StatusForbidden, w.Code)
}

func TestRenomearConta(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	patch := func(corpo string) *httptest.ResponseRecorder {
		return servir(r, comCookie(t, cfg, pedidoJSON(t, http.MethodPatch, "/api/auth/conta", corpo), eu))
	}

	w := patch(`{"name":"  Thiago  "}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, "Thiago", corpoDe(t, w)["name"], "a resposta já traz o nome novo, aparado")

	me := meDe(t, r, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/auth/me", nil), eu))
	require.Equal(t, "Thiago", me["name"])

	for _, ruim := range []string{`{"name":""}`, `{"name":"   "}`, `{}`,
		`{"name":"` + strings.Repeat("n", auth.NomeMaximo+1) + `"}`} {
		w = patch(ruim)
		require.Equal(t, http.StatusBadRequest, w.Code, ruim)
		require.Equal(t, CodNomeInvalido, corpoDe(t, w)["code"], ruim)
	}

	// Sem sessão, nada.
	w = servir(r, pedidoJSON(t, http.MethodPatch, "/api/auth/conta", `{"name":"x"}`))
	require.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestTrocarSenha(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := contaComSenha(t, pool, "eu@exemplo.test")
	post := func(corpo string) *httptest.ResponseRecorder {
		return servir(r, comCookie(t, cfg, pedidoJSON(t, http.MethodPost, "/api/auth/senha", corpo), eu))
	}

	// Senha atual errada: 403, e NUNCA 401 — o cliente leria como sessão morta.
	w := post(`{"atual":"nao-e-esta-123","nova":"outra-senha-456"}`)
	require.Equal(t, http.StatusForbidden, w.Code)
	require.Equal(t, CodSenhaAtualIncorreta, corpoDe(t, w)["code"])

	w = post(`{"atual":"` + senhaDeTeste + `","nova":"curta"}`)
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Equal(t, CodSenhaCurta, corpoDe(t, w)["code"])

	require.Equal(t, http.StatusOK, entrar(t, r, "eu@exemplo.test", senhaDeTeste).Code, "nada mudou até aqui")

	w = post(`{"atual":"` + senhaDeTeste + `","nova":"outra-senha-456"}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	require.Equal(t, http.StatusUnauthorized, entrar(t, r, "eu@exemplo.test", senhaDeTeste).Code)
	require.Equal(t, http.StatusOK, entrar(t, r, "eu@exemplo.test", "outra-senha-456").Code)
}

// Com a sessão na mão, o freio de tentativas é por conta: sem ele a troca de
// senha seria um oráculo ilimitado da senha atual.
func TestSenhaAtualTemFreioPorConta(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := contaComSenha(t, pool, "eu@exemplo.test")
	for i := 0; i < cfg.LoginAttempts; i++ {
		w := servir(r, comCookie(t, cfg, pedidoJSON(t, http.MethodPost, "/api/auth/senha",
			`{"atual":"errada-123456","nova":"outra-senha-456"}`), eu))
		require.Equal(t, http.StatusForbidden, w.Code)
	}
	w := servir(r, comCookie(t, cfg, pedidoJSON(t, http.MethodPost, "/api/auth/conta/apagar",
		`{"senha":"`+senhaDeTeste+`"}`), eu))
	require.Equal(t, http.StatusTooManyRequests, w.Code, "o freio vale para as duas ações que pedem a senha")
}

// Apagar a conta leva tudo que é dela — inclusive o que o CASCADE do banco não
// alcança: os objetos no bucket e os rastros da faixa em OUTRAS contas.
func TestApagarContaLevaAsFaixasEOsObjetos(t *testing.T) {
	b := novoBucket()
	r, pool, cfg := montarComBucket(t, b)
	ctx := context.Background()
	eu := contaComSenha(t, pool, "eu@exemplo.test")
	outra := dbtest.CriarUsuario(t, pool, "outra@exemplo.test")

	id := "55555555-5555-4555-8555-555555555555"
	audioKey := "u/" + eu + "/a/" + id + ".mp3"
	artKey := "u/" + eu + "/c/" + id + ".jpg"
	tracks := acervo.NewTracks(pool)
	_, err := tracks.Criar(ctx, acervo.Nova{
		ID: id, UserID: eu, Title: "Minha", Artist: "Eu", Genre: "acervo", DurS: 10,
		AudioKey: audioKey, AudioType: "audio/mpeg", SizeBytes: 1, ArtKey: artKey,
		Visibilidade: acervo.VisibilidadeTodos,
	})
	require.NoError(t, err)
	b.semear(audioKey, 1)
	b.semear(artKey, 1)

	// A outra conta curtiu a faixa compartilhada: é o rastro sem FK.
	w := servir(r, comCookie(t, cfg, patchLikes(t, `{"add":["acervo:`+id+`"]}`), outra))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	apagar := func(senha string) *httptest.ResponseRecorder {
		return servir(r, comCookie(t, cfg, pedidoJSON(t, http.MethodPost, "/api/auth/conta/apagar",
			`{"senha":"`+senha+`"}`), eu))
	}

	w = apagar("nao-e-esta-123")
	require.Equal(t, http.StatusForbidden, w.Code)
	require.Equal(t, CodSenhaAtualIncorreta, corpoDe(t, w)["code"])
	_, err = tracks.PorID(ctx, eu, id)
	require.NoError(t, err, "senha errada não pode ter apagado nada")

	w = apagar(senhaDeTeste)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var contas, faixas int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE id = $1`, eu).Scan(&contas))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM tracks`).Scan(&faixas))
	require.Zero(t, contas)
	require.Zero(t, faixas)
	require.True(t, b.foiApagado(audioKey), "o áudio tem de sair do bucket")
	require.True(t, b.foiApagado(artKey), "a capa tem de sair do bucket")

	w = servir(r, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/likes", nil), outra))
	require.Equal(t, http.StatusOK, w.Code)
	require.Empty(t, idsDe(t, w), "a curtida da outra conta não pode apontar para o nada")

	// O cookie antigo morreu com a conta, e o e-mail está livre de novo.
	w = servir(r, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/auth/me", nil), eu))
	require.Equal(t, http.StatusUnauthorized, w.Code)
	require.Equal(t, http.StatusUnauthorized, entrar(t, r, "eu@exemplo.test", senhaDeTeste).Code)
}

// A migração 0011 não pode trancar para fora quem já tinha conta: o padrão das
// colunas é o estado fechado, e o que salva as contas antigas é a ORDEM dos
// dois passos (ver o arquivo). Este teste refaz o cenário do dia do deploy.
func TestMigracaoMantemAsContasQueJaExistiam(t *testing.T) {
	pool := dbtest.Pool(t)
	ctx := context.Background()

	// Volta o esquema ao que era antes da 0011, com uma conta já lá dentro.
	_, err := pool.Exec(ctx, `
		ALTER TABLE users DROP COLUMN status, DROP COLUMN pode_enviar,
		                  DROP COLUMN pedido_msg, DROP COLUMN decidido_em;
		INSERT INTO users (email, name, password_hash) VALUES ('antiga@exemplo.test', 'antiga', 'x');`)
	require.NoError(t, err)

	sql, err := os.ReadFile("../db/migrations/0011_cadastro.sql")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, string(sql))
	require.NoError(t, err)

	var status string
	var podeEnviar bool
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT status, pode_enviar FROM users WHERE email = 'antiga@exemplo.test'`).Scan(&status, &podeEnviar))
	require.Equal(t, auth.StatusAprovada, status)
	require.True(t, podeEnviar)

	// E a conta criada DEPOIS nasce fechada, mesmo num INSERT que esqueça os campos.
	_, err = pool.Exec(ctx, `INSERT INTO users (email, name, password_hash) VALUES ('nova@exemplo.test', 'nova', 'x')`)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT status, pode_enviar FROM users WHERE email = 'nova@exemplo.test'`).Scan(&status, &podeEnviar))
	require.Equal(t, auth.StatusPendente, status)
	require.False(t, podeEnviar)
}
