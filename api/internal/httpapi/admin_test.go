package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/thiagotn/ondas/api/internal/acervo"
	"github.com/thiagotn/ondas/api/internal/admin"
	"github.com/thiagotn/ondas/api/internal/auth"
	"github.com/thiagotn/ondas/api/internal/dbtest"
)

// O painel de admin (migração 0012): sessão por cookie, e o que saiu do
// ConfigMap. A régua de autenticação de cada rota está em
// `TestAdminExigeOTokenDeAdmin` (cadastro_test.go).

func entrarNoPainel(t *testing.T, r http.Handler, token string) *httptest.ResponseRecorder {
	t.Helper()
	return servir(r, pedidoJSON(t, http.MethodPost, "/api/admin/sessao", `{"token":"`+token+`"}`))
}

func cookieDoPainel(t *testing.T, w *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range w.Result().Cookies() {
		if c.Name == cookieAdmin {
			return c
		}
	}
	t.Fatalf("a resposta não trouxe o cookie do painel: %s", w.Body.String())
	return nil
}

func TestPainelTrocaOTokenPorCookieRestrito(t *testing.T) {
	r, _, cfg := montarComAdmin(t)
	// Em produção o cookie é `Secure`; o `montar` desliga isso para os testes
	// de sessão de usuário, e aqui é justamente o que se quer conferir.
	cfg.SessionInsecure = false

	w := entrarNoPainel(t, r, "token-errado")
	require.Equal(t, http.StatusUnauthorized, w.Code)
	require.Empty(t, w.Result().Cookies(), "token errado não ganha cookie")

	w = entrarNoPainel(t, r, tokenDoAdmin)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	c := cookieDoPainel(t, w)
	require.True(t, c.HttpOnly, "o token não pode ficar ao alcance de script")
	require.True(t, c.Secure)
	require.Equal(t, http.SameSiteStrictMode, c.SameSite)
	require.Equal(t, "/api/admin", c.Path, "o cookie só viaja para as rotas de admin")
	require.NotContains(t, c.Value, tokenDoAdmin, "o cookie não carrega o token")

	// Com o cookie, sem cabeçalho nenhum, o painel lê.
	req := httptest.NewRequest(http.MethodGet, "/api/admin/resumo", nil)
	req.AddCookie(c)
	require.Equal(t, http.StatusOK, servir(r, req).Code)
}

// O cookie do painel não é uma sessão de usuário, e o contrário também: os dois
// são assinados com chaves diferentes, e nenhum abre a porta do outro.
func TestCookieDoPainelEDeUsuarioNaoSeMisturam(t *testing.T) {
	r, pool, cfg := montarComAdmin(t)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	painel := cookieDoPainel(t, entrarNoPainel(t, r, tokenDoAdmin))

	// O valor do cookie do painel, no cookie de sessão: não é uma conta.
	req := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	req.AddCookie(&http.Cookie{Name: cfg.SessionCookie, Value: painel.Value})
	require.Equal(t, http.StatusUnauthorized, servir(r, req).Code)

	// O valor de uma sessão de usuário, no cookie do painel: não é o admin.
	sessao := novasSessoesDeTeste(cfg).Sign(eu)
	req = httptest.NewRequest(http.MethodGet, "/api/admin/resumo", nil)
	req.AddCookie(&http.Cookie{Name: cookieAdmin, Value: sessao})
	require.Equal(t, http.StatusUnauthorized, servir(r, req).Code)

	// Nem uma sessão assinada com a chave de usuário e sujeito "admin".
	forjada := novasSessoesDeTeste(cfg).Sign(sujeitoAdmin)
	req = httptest.NewRequest(http.MethodGet, "/api/admin/resumo", nil)
	req.AddCookie(&http.Cookie{Name: cookieAdmin, Value: forjada})
	require.Equal(t, http.StatusUnauthorized, servir(r, req).Code)
}

// Trocar o token de admin derruba as sessões abertas do painel: quem tinha o
// cookie tinha o token antigo.
func TestTrocarOTokenDerrubaASessaoDoPainel(t *testing.T) {
	r, _, cfg := montarComAdmin(t)
	c := cookieDoPainel(t, entrarNoPainel(t, r, tokenDoAdmin))

	cfg.AdminTokenSHA256 = somaDoToken("outro-token-de-admin")

	req := httptest.NewRequest(http.MethodGet, "/api/admin/resumo", nil)
	req.AddCookie(c)
	require.Equal(t, http.StatusUnauthorized, servir(r, req).Code)
}

// O uso normal do painel não pode trancar o admin: o freio conta só o erro.
func TestPedidosValidosDoPainelNaoGastamOFreio(t *testing.T) {
	r, _, cfg := montarComAdmin(t)
	c := cookieDoPainel(t, entrarNoPainel(t, r, tokenDoAdmin))
	for i := 0; i < cfg.LoginAttempts*3; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/admin/resumo", nil)
		req.AddCookie(c)
		require.Equal(t, http.StatusOK, servir(r, req).Code, "pedido %d", i)
	}
}

// Abrir o painel deslogado pergunta "estou dentro?" sem credencial nenhuma. Isso
// não é tentativa de adivinhar o token, e não pode gastar o freio de quem vai
// digitar o token certo em seguida.
func TestAbrirOPainelDeslogadoNaoGastaOFreio(t *testing.T) {
	r, _, cfg := montarComAdmin(t)
	for i := 0; i < cfg.LoginAttempts*3; i++ {
		w := servir(r, httptest.NewRequest(http.MethodGet, "/api/admin/sessao", nil))
		require.Equal(t, http.StatusUnauthorized, w.Code)
	}
	require.Equal(t, http.StatusOK, entrarNoPainel(t, r, tokenDoAdmin).Code)

	// Já o cookie FORJADO conta, como o token errado.
	for i := 0; i < cfg.LoginAttempts; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/admin/resumo", nil)
		req.AddCookie(&http.Cookie{Name: cookieAdmin, Value: "v1.forjado.forjado"})
		require.Equal(t, http.StatusUnauthorized, servir(r, req).Code)
	}
	require.Equal(t, http.StatusTooManyRequests, entrarNoPainel(t, r, tokenDoAdmin).Code)
}

func TestPainelSemTokenConfiguradoNaoExiste(t *testing.T) {
	r, _, _ := montar(t, true)
	require.Equal(t, http.StatusNotFound, entrarNoPainel(t, r, tokenDoAdmin).Code)
	w := servir(r, httptest.NewRequest(http.MethodDelete, "/api/admin/sessao", nil))
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestSairDoPainelApagaOCookie(t *testing.T) {
	r, _, _ := montarComAdmin(t)
	w := servir(r, httptest.NewRequest(http.MethodDelete, "/api/admin/sessao", nil))
	require.Equal(t, http.StatusOK, w.Code)
	require.Negative(t, cookieDoPainel(t, w).MaxAge)
}

// A chave do cadastro mora no banco e vale no pedido seguinte, sem restart.
func TestAdminAbreEFechaOCadastro(t *testing.T) {
	r, _, cfg := montar(t, true)
	cfg.AdminTokenSHA256 = somaDoToken(tokenDoAdmin)

	require.Equal(t, http.StatusForbidden, pedirConta(t, r, "a@exemplo.test").Code, "banco novo nasce fechado")

	w := servir(r, comAdmin(pedidoJSON(t, http.MethodPut, "/api/admin/config", `{"cadastroAberto":true}`)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, http.StatusAccepted, pedirConta(t, r, "a@exemplo.test").Code)

	w = servir(r, comAdmin(pedidoJSON(t, http.MethodPut, "/api/admin/config", `{"cadastroAberto":false}`)))
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, http.StatusForbidden, pedirConta(t, r, "b@exemplo.test").Code)

	// Corpo sem a chave não pode fechar (nem abrir) nada.
	w = servir(r, comAdmin(pedidoJSON(t, http.MethodPut, "/api/admin/config", `{}`)))
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestAdminConvidaERemoveConvite(t *testing.T) {
	r, pool, _ := montarComAdmin(t)
	dbtest.CriarUsuario(t, pool, "jatem@exemplo.test")

	w := servir(r, comAdmin(pedidoJSON(t, http.MethodPost, "/api/admin/convites",
		`{"email":" Amiga@Exemplo.test ","podeEnviar":true,"nota":"do coral"}`)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, "amiga@exemplo.test", corpoDe(t, w)["email"], "guardado em minúsculas")

	// Quem já tem conta não é convidável: o que o admin quer está na conta.
	w = servir(r, comAdmin(pedidoJSON(t, http.MethodPost, "/api/admin/convites", `{"email":"JaTem@exemplo.test"}`)))
	require.Equal(t, http.StatusConflict, w.Code)

	w = servir(r, comAdmin(pedidoJSON(t, http.MethodPost, "/api/admin/convites", `{"email":"sem-arroba"}`)))
	require.Equal(t, http.StatusBadRequest, w.Code)

	w = servir(r, comAdmin(httptest.NewRequest(http.MethodGet, "/api/admin/convites", nil)))
	require.Equal(t, http.StatusOK, w.Code)
	require.Len(t, corpoDe(t, w)["convites"], 1)

	w = servir(r, comAdmin(httptest.NewRequest(http.MethodDelete, "/api/admin/convites?email=AMIGA@exemplo.test", nil)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	w = servir(r, comAdmin(httptest.NewRequest(http.MethodDelete, "/api/admin/convites?email=amiga@exemplo.test", nil)))
	require.Equal(t, http.StatusNotFound, w.Code, "já tinha saído")
}

// A linha da conta no painel: faixas, ocupação (áudio + capas) e cota (plano +
// extra). E a mesma conta lida pelo dono em `/api/auth/uso`.
func TestPainelMostraOcupacaoECotaDaConta(t *testing.T) {
	r, pool, cfg := montarComAdmin(t)
	ctx := context.Background()
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	outra := dbtest.CriarUsuario(t, pool, "outra@exemplo.test")
	tracks := acervo.NewTracks(pool)

	for _, f := range []acervo.Nova{
		{ID: "11111111-1111-4111-8111-111111111111", UserID: eu, SizeBytes: 1000, ArtBytes: 50},
		{ID: "22222222-2222-4222-8222-222222222222", UserID: eu, SizeBytes: 3000},
		{ID: "33333333-3333-4333-8333-333333333333", UserID: outra, SizeBytes: 700},
	} {
		f.Title, f.Artist, f.Genre, f.DurS = "t", "a", "acervo", 10
		f.AudioKey, f.AudioType = "u/"+f.UserID+"/a/"+f.ID+".mp3", "audio/mpeg"
		_, err := tracks.Criar(ctx, f)
		require.NoError(t, err)
	}

	// Plano novo com 2000 bytes, e 500 de extra avulso: cota de 2500.
	w := servir(r, comAdmin(pedidoJSON(t, http.MethodPost, "/api/admin/planos",
		`{"id":"mini","nome":"mini","cotaBytes":2000}`)))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	w = servir(r, comAdmin(pedidoJSON(t, http.MethodPatch, "/api/admin/contas/"+eu,
		`{"planoId":"mini","cotaExtraBytes":500,"recebeDoBot":true}`)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	conta := corpoDe(t, w)
	require.EqualValues(t, 2, conta["faixas"])
	require.EqualValues(t, 4050, conta["usadoBytes"], "áudio + capas, só das faixas da conta")
	require.EqualValues(t, 2500, conta["cotaBytes"], "plano + extra")
	require.Equal(t, true, conta["recebeDoBot"])
	require.Equal(t, "mini", conta["planoId"])

	// O dono vê os mesmos dois números — e nada o impede de seguir usando: a
	// cota, nesta versão, só é medida.
	w = servir(r, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/auth/uso", nil), eu))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	uso := corpoDe(t, w)
	require.EqualValues(t, 4050, uso["usadoBytes"])
	require.EqualValues(t, 2500, uso["cotaBytes"])

	// Mudar a cota do plano vale na hora para a conta: ela é calculada.
	w = servir(r, comAdmin(pedidoJSON(t, http.MethodPatch, "/api/admin/planos/mini", `{"cotaBytes":9000}`)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	w = servir(r, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/auth/uso", nil), eu))
	require.EqualValues(t, 9500, corpoDe(t, w)["cotaBytes"])

	// O detalhe traz as faixas com o tamanho de cada uma.
	w = servir(r, comAdmin(httptest.NewRequest(http.MethodGet, "/api/admin/contas/"+eu, nil)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Len(t, corpoDe(t, w)["faixas"], 2)

	// E o resumo soma tudo, e sabe que uma conta passou da cota? Não mais:
	// 4050 < 9500. Volta o plano para 2000 e ela passa.
	servir(r, comAdmin(pedidoJSON(t, http.MethodPatch, "/api/admin/planos/mini", `{"cotaBytes":2000}`)))
	w = servir(r, comAdmin(httptest.NewRequest(http.MethodGet, "/api/admin/resumo", nil)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	resumo := corpoDe(t, w)
	require.EqualValues(t, 3, resumo["faixas"])
	require.EqualValues(t, 4700, resumo["audioBytes"])
	require.EqualValues(t, 50, resumo["capaBytes"])
	require.EqualValues(t, 1, resumo["acimaDaCota"])

	// Ajuste inválido não passa: plano que não existe, extra negativo, corpo vazio.
	for _, ruim := range []string{`{"planoId":"nao-existe"}`, `{"cotaExtraBytes":-1}`, `{}`} {
		w = servir(r, comAdmin(pedidoJSON(t, http.MethodPatch, "/api/admin/contas/"+eu, ruim)))
		require.Equal(t, http.StatusBadRequest, w.Code, ruim)
	}
}

// Apagar pelo painel passa pelo MESMO caminho do dono: os objetos saem do
// bucket, e o histórico guarda o que foi apagado mesmo depois que a conta sumiu.
func TestAdminApagaContaEFaixaLimpandoOBucket(t *testing.T) {
	b := novoBucket()
	r, pool, cfg := montarComBucket(t, b)
	cfg.AdminTokenSHA256 = somaDoToken(tokenDoAdmin)
	ctx := context.Background()
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	tracks := acervo.NewTracks(pool)

	semear := func(id string) string {
		key := "u/" + eu + "/a/" + id + ".mp3"
		_, err := tracks.Criar(ctx, acervo.Nova{
			ID: id, UserID: eu, Title: "Faixa " + id[:4], Artist: "a", Genre: "acervo", DurS: 10,
			AudioKey: key, AudioType: "audio/mpeg", SizeBytes: 1,
		})
		require.NoError(t, err)
		b.semear(key, 1)
		return key
	}
	uma := "44444444-4444-4444-8444-444444444444"
	outra := "55555555-5555-4555-8555-555555555555"
	keyUma, keyOutra := semear(uma), semear(outra)

	w := servir(r, comAdmin(httptest.NewRequest(http.MethodDelete, "/api/admin/faixas/"+uma, nil)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.True(t, b.foiApagado(keyUma))
	_, err := tracks.PorID(ctx, eu, outra)
	require.NoError(t, err, "a outra faixa fica")

	w = servir(r, comAdmin(httptest.NewRequest(http.MethodDelete, "/api/admin/faixas/"+uma, nil)))
	require.Equal(t, http.StatusNotFound, w.Code)

	w = servir(r, comAdmin(httptest.NewRequest(http.MethodDelete, "/api/admin/contas/"+eu, nil)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.True(t, b.foiApagado(keyOutra))
	var contas int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE id = $1`, eu).Scan(&contas))
	require.Zero(t, contas)

	w = servir(r, comAdmin(httptest.NewRequest(http.MethodGet, "/api/admin/eventos", nil)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var acoes []string
	for _, e := range corpoDe(t, w)["eventos"].([]any) {
		ev := e.(map[string]any)
		acoes = append(acoes, ev["acao"].(string))
		if ev["acao"] == "conta.apagada" {
			require.Equal(t, "eu@exemplo.test", ev["alvoRotulo"], "o e-mail sobrevive à conta")
		}
	}
	require.Equal(t, []string{"conta.apagada", "faixa.apagada"}, acoes)
}

// A fila de ingestão no painel não repete a URL inteira: ela pode trazer token
// de acesso na query.
func TestPainelResumeAFonteDaIngestao(t *testing.T) {
	r, pool, _ := montarComAdmin(t)
	ctx := context.Background()
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	jobs := acervo.NewJobs(pool)
	_, _, err := jobs.Enfileirar(ctx, eu, "https://midia.exemplo.test/a.mp3?token=segredo", "Uma", "", acervo.Destino{})
	require.NoError(t, err)

	w := servir(r, comAdmin(httptest.NewRequest(http.MethodGet, "/api/admin/ingestoes?status=pending", nil)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NotContains(t, w.Body.String(), "segredo")
	lista := corpoDe(t, w)["ingestoes"].([]any)
	require.Len(t, lista, 1)
	require.Equal(t, "midia.exemplo.test", lista[0].(map[string]any)["fonte"])
	require.Equal(t, "eu@exemplo.test", lista[0].(map[string]any)["pedidoPor"])

	w = servir(r, comAdmin(httptest.NewRequest(http.MethodGet, "/api/admin/ingestoes?status=inventado", nil)))
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestLoginAnotaOUltimoAcesso(t *testing.T) {
	r, pool, _ := montarComAdmin(t)
	id := contaComSenha(t, pool, "eu@exemplo.test")

	w := servir(r, comAdmin(httptest.NewRequest(http.MethodGet, "/api/admin/contas/"+id, nil)))
	require.Nil(t, corpoDe(t, w)["conta"].(map[string]any)["ultimoLoginEm"])

	require.Equal(t, http.StatusOK, entrar(t, r, "eu@exemplo.test", senhaDeTeste).Code)

	w = servir(r, comAdmin(httptest.NewRequest(http.MethodGet, "/api/admin/contas/"+id, nil)))
	require.NotNil(t, corpoDe(t, w)["conta"].(map[string]any)["ultimoLoginEm"])
}

// A 0012 não pode mudar nada para quem já estava: plano padrão, sem extra, e
// fora do alcance do bot até a importação do env (ou o admin) dizer o contrário.
func TestMigracao0012MantemAsContasEAsFaixas(t *testing.T) {
	pool := dbtest.Pool(t)
	ctx := context.Background()

	_, err := pool.Exec(ctx, `
		ALTER TABLE users DROP COLUMN recebe_do_bot, DROP COLUMN ultimo_login_em,
		                  DROP COLUMN plano_id, DROP COLUMN cota_extra_bytes;
		ALTER TABLE tracks DROP COLUMN art_bytes;
		DROP TABLE planos, convites, config, admin_eventos;
		INSERT INTO users (email, name, password_hash, status, pode_enviar)
		VALUES ('antiga@exemplo.test', 'antiga', 'x', 'aprovada', true);
		INSERT INTO tracks (id, user_id, title, artist, genre, duration_s, audio_key, audio_type, size_bytes)
		SELECT '66666666-6666-4666-8666-666666666666', id, 't', 'a', 'acervo', 10, 'k', 'audio/mpeg', 123
		  FROM users WHERE email = 'antiga@exemplo.test';`)
	require.NoError(t, err)

	sql, err := os.ReadFile("../db/migrations/0012_admin.sql")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, string(sql))
	require.NoError(t, err)
	// Rodar de novo não pode quebrar nem duplicar o plano padrão.
	_, err = pool.Exec(ctx, string(sql))
	require.NoError(t, err)

	contas, err := admin.New(pool).Contas(ctx, "", "antiga@exemplo.test")
	require.NoError(t, err)
	require.Len(t, contas, 1)
	c := contas[0]
	require.Equal(t, auth.StatusAprovada, c.Status)
	require.True(t, c.PodeEnviar)
	require.False(t, c.RecebeDoBot)
	require.Equal(t, admin.PlanoPadrao, c.PlanoID)
	require.EqualValues(t, 1<<30, c.CotaBytes)
	require.EqualValues(t, 123, c.UsadoBytes)
}

// O teto de envio por conta: o admin escreve, limpa, e não passa do absoluto.
func TestAdminAjustaOTetoDeEnvioDaConta(t *testing.T) {
	r, pool, _ := montarComAdmin(t)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	rota := "/api/admin/contas/" + eu

	// Conta nova não tem teto próprio: a chave nem vai.
	w := servir(r, comAdmin(httptest.NewRequest(http.MethodGet, rota, nil)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NotContains(t, corpoDe(t, w)["conta"], "maxUploadBytes")

	w = servir(r, comAdmin(pedidoJSON(t, http.MethodPatch, rota, `{"maxUploadBytes":524288000}`)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.EqualValues(t, 500<<20, corpoDe(t, w)["maxUploadBytes"])

	// Mexer em outra coisa não mexe no teto: ausente é "não mexa".
	w = servir(r, comAdmin(pedidoJSON(t, http.MethodPatch, rota, `{"cotaExtraBytes":10}`)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.EqualValues(t, 500<<20, corpoDe(t, w)["maxUploadBytes"])

	// Fora dos limites não entra — e o que estava continua.
	for _, ruim := range []string{`{"maxUploadBytes":-1}`, `{"maxUploadBytes":943718401}`} {
		w = servir(r, comAdmin(pedidoJSON(t, http.MethodPatch, rota, ruim)))
		require.Equal(t, http.StatusBadRequest, w.Code, ruim)
	}
	// O absoluto em si entra.
	w = servir(r, comAdmin(pedidoJSON(t, http.MethodPatch, rota, `{"maxUploadBytes":943718400}`)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.EqualValues(t, admin.MaxTetoDeEnvio, corpoDe(t, w)["maxUploadBytes"])

	// Zero volta ao padrão do servidor.
	w = servir(r, comAdmin(pedidoJSON(t, http.MethodPatch, rota, `{"maxUploadBytes":0}`)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NotContains(t, corpoDe(t, w), "maxUploadBytes")

	teto, err := admin.New(pool).TetoDeEnvio(context.Background(), eu, 60<<20)
	require.NoError(t, err)
	require.EqualValues(t, 60<<20, teto, "sem teto próprio, vale o padrão de quem pergunta")

	// E o histórico diz o que foi mexido.
	w = servir(r, comAdmin(httptest.NewRequest(http.MethodGet, "/api/admin/eventos", nil)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "teto de envio: 524288000 bytes")
	require.Contains(t, w.Body.String(), "teto de envio: padrão")
}
