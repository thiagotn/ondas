package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/thiagotn/ondas/api/internal/acervo"
	"github.com/thiagotn/ondas/api/internal/admin"
	"github.com/thiagotn/ondas/api/internal/dbtest"
	"github.com/thiagotn/ondas/api/internal/storage"
)

// Trazer faixa por link pela PWA (migração 0013): o link de página é job do
// NODE, o resto continua do worker, e a cota passa a recusar.

const (
	linkDoYouTube  = "https://youtu.be/dQw4w9WgXcQ?si=rastreador"
	videoCanonico  = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
	rotaReivindica = "/api/acervo/paginas/reivindicar"
)

func ingerirURL(t *testing.T, url string) *http.Request {
	t.Helper()
	return pedidoJSON(t, http.MethodPost, "/api/acervo/ingest", `{"url":"`+url+`"}`)
}

func comTokenDoBot(req *http.Request) *http.Request {
	req.Header.Set("X-Ondas-Token", tokenDoBot)
	return req
}

// cotaDe deixa a conta com exatamente `bytes` de cota (plano próprio, sem extra).
func cotaDe(t *testing.T, pool *pgxpool.Pool, userID string, bytes int64) {
	t.Helper()
	ctx := context.Background()
	p := admin.New(pool)
	id := "t" + userID[:8]
	_, err := p.CriarPlano(ctx, id, "teste", bytes)
	require.NoError(t, err)
	_, err = p.AjustarConta(ctx, userID, admin.Ajuste{PlanoID: &id})
	require.NoError(t, err)
}

func TestLinkDePaginaPelaSessaoViraJobDoNode(t *testing.T) {
	r, pool, cfg := montar(t, true)
	ctx := context.Background()
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	jobs := acervo.NewJobs(pool)

	w := servir(r, comCookie(t, cfg, ingerirURL(t, linkDoYouTube), eu))
	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())
	corpo := corpoDe(t, w)
	require.Equal(t, "pagina", corpo["tipo"])
	require.Equal(t, videoCanonico, corpo["url"], "a URL guardada é a canônica, sem rastreador")

	// O mesmo vídeo colado de outro jeito é o MESMO pedido, não um segundo download.
	w = servir(r, comCookie(t, cfg, ingerirURL(t, "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDxyz"), eu))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, corpo["id"], corpoDe(t, w)["id"])

	// O worker do cluster NÃO pega: ele baixaria HTML.
	_, err := jobs.Reivindicar(ctx)
	require.ErrorIs(t, err, acervo.ErrFilaVazia)
}

func TestLinkQueNaoEhDeUmaFaixaERecusadoNaEntrada(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	dbtest.CriarUsuario(t, pool, "outra@exemplo.test")

	for _, url := range []string{
		"https://www.youtube.com/playlist?list=PLabcdefghijklmnop",
		"https://www.youtube.com/@canal",
		"https://soundcloud.com/artista/sets/album",
		"https://soundcloud.com/artista",
	} {
		w := servir(r, comCookie(t, cfg, ingerirURL(t, url), eu))
		require.Equal(t, http.StatusBadRequest, w.Code, url)
		require.Equal(t, CodLinkNaoSuportado, corpoDe(t, w)["code"], url)
	}

	// Página é sempre para a própria conta.
	req := pedidoJSON(t, http.MethodPost, "/api/acervo/ingest",
		`{"url":"`+linkDoYouTube+`","para":"outra@exemplo.test"}`)
	require.Equal(t, http.StatusBadRequest, servir(r, comCookie(t, cfg, req, eu)).Code)
}

// Pelo token nada muda: o bot faz o próprio download, e o que ele manda para
// esta rota continua sendo tratado como URL de mídia.
func TestPeloTokenOLinkNaoEClassificado(t *testing.T) {
	r, pool, _ := montar(t, true)
	dono := dbtest.CriarUsuario(t, pool, "dono@exemplo.test")

	w := servir(r, comTokenDoBot(ingerirURL(t, linkDoYouTube)))
	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())
	job, err := acervo.NewJobs(pool).PorID(context.Background(), dono, jobDaResposta(t, w))
	require.NoError(t, err)
	require.Equal(t, acervo.TipoMidia, job.Tipo)
	require.Equal(t, linkDoYouTube, job.SourceURL)
}

// O ciclo inteiro do node: pega o link, pede a vaga, grava, entrega. O arquivo
// vai para a área de espera de quem PEDIU, e o job — o mesmo id — vira mídia
// para o worker do cluster.
func TestNodeBaixaALinkEAFaixaVaiParaQuemPediu(t *testing.T) {
	b := novoBucket()
	r, pool, cfg := montarComBucket(t, b)
	ctx := context.Background()
	dbtest.CriarUsuario(t, pool, "dono@exemplo.test") // a conta do bot
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	jobs := acervo.NewJobs(pool)

	w := servir(r, comCookie(t, cfg, ingerirURL(t, linkDoYouTube), eu))
	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())
	id := jobDaResposta(t, w)

	w = servir(r, comTokenDoBot(httptest.NewRequest(http.MethodPost, rotaReivindica, nil)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	pagina := corpoDe(t, w)
	require.Equal(t, id, pagina["id"])
	require.Equal(t, videoCanonico, pagina["url"])

	// A fila ficou vazia: 204, não erro.
	w = servir(r, comTokenDoBot(httptest.NewRequest(http.MethodPost, rotaReivindica, nil)))
	require.Equal(t, http.StatusNoContent, w.Code)

	w = servir(r, comTokenDoBot(pedidoJSON(t, http.MethodPost, "/api/acervo/paginas/"+id+"/vaga", `{"bytes":4096}`)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	vaga := corpoDe(t, w)
	uploadID := vaga["id"].(string)
	require.Contains(t, vaga["url"], "stage/"+eu+"/", "a vaga é na área de espera de quem pediu")

	// Entregar sem ter gravado: o arquivo não está lá.
	corpoPronto := `{"uploadId":"` + uploadID + `","title":"Never Gonna","artist":"Rick","nome":"video"}`
	w = servir(r, comTokenDoBot(pedidoJSON(t, http.MethodPost, "/api/acervo/paginas/"+id+"/pronto", corpoPronto)))
	require.Equal(t, http.StatusNotFound, w.Code)

	b.semear(storage.KeyUploadStage(eu, uploadID), 4096)
	w = servir(r, comTokenDoBot(pedidoJSON(t, http.MethodPost, "/api/acervo/paginas/"+id+"/pronto", corpoPronto)))
	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())

	job, err := jobs.PorID(ctx, eu, id)
	require.NoError(t, err)
	require.Equal(t, acervo.TipoMidia, job.Tipo)
	require.Equal(t, "pending", job.Status)
	require.Zero(t, job.Attempts, "as tentativas do download não gastam as da ingestão")
	require.Equal(t, acervo.FonteUpload(uploadID), job.SourceURL)
	require.Equal(t, "Never Gonna", job.Title)
	require.Empty(t, job.DestinoID, "o dono é quem pediu; o node não nomeia conta")

	// Quem pediu continua vendo o LINK, e não `upload:<uuid>`.
	w = servir(r, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/acervo/ingest/"+id, nil), eu))
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, videoCanonico, corpoDe(t, w)["url"])

	// Agora sim o worker do cluster o pega.
	doWorker, err := jobs.Reivindicar(ctx)
	require.NoError(t, err)
	require.Equal(t, id, doWorker.ID)

	// E o node não mexe mais nele: deixou de ser página em andamento.
	w = servir(r, comTokenDoBot(pedidoJSON(t, http.MethodPost, "/api/acervo/paginas/"+id+"/vaga", `{"bytes":10}`)))
	require.Equal(t, http.StatusNotFound, w.Code)
}

// A divisão dos grupos do roteador, como `TestEscopoDoTokenNoAcervo`: estas
// rotas são do node, e nem sessão nem o token de admin as abrem. E o token só
// enxerga job de PÁGINA em andamento.
func TestRotasDoNodeSoAbremComOTokenDeMaquina(t *testing.T) {
	r, pool, cfg := montarComAdmin(t)
	ctx := context.Background()
	dbtest.CriarUsuario(t, pool, "dono@exemplo.test")
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	const umID = "33333333-3333-4333-8333-333333333333"
	rotas := []string{
		rotaReivindica,
		"/api/acervo/paginas/" + umID + "/vaga",
		"/api/acervo/paginas/" + umID + "/pronto",
		"/api/acervo/paginas/" + umID + "/falha",
	}
	for _, rota := range rotas {
		w := servir(r, pedidoJSON(t, http.MethodPost, rota, `{}`))
		require.Equal(t, http.StatusUnauthorized, w.Code, "%s sem credencial", rota)

		w = servir(r, comCookie(t, cfg, pedidoJSON(t, http.MethodPost, rota, `{}`), eu))
		require.Equal(t, http.StatusUnauthorized, w.Code, "%s com sessão", rota)

		req := pedidoJSON(t, http.MethodPost, rota, `{}`)
		req.Header.Set("X-Ondas-Token", tokenDoAdmin)
		require.Equal(t, http.StatusUnauthorized, servir(r, req).Code, "%s com token de admin", rota)

		req = pedidoJSON(t, http.MethodPost, rota, `{}`)
		req.Header.Set(cabecalhoAdmin, tokenDoAdmin)
		require.Equal(t, http.StatusUnauthorized, servir(r, req).Code, "%s com cabeçalho de admin", rota)
	}

	// Um job de MÍDIA em andamento não é alcançado por estas rotas.
	jobs := acervo.NewJobs(pool)
	midia, _, err := jobs.Enfileirar(ctx, eu, "https://exemplo.test/a.mp3", "", "", acervo.Destino{})
	require.NoError(t, err)
	_, err = jobs.Reivindicar(ctx)
	require.NoError(t, err)
	w := servir(r, comTokenDoBot(pedidoJSON(t, http.MethodPost, "/api/acervo/paginas/"+midia.ID+"/vaga", `{"bytes":10}`)))
	require.Equal(t, http.StatusNotFound, w.Code)

	// Nem um job de página que ninguém reivindicou ainda.
	pagina, _, err := jobs.EnfileirarPagina(ctx, eu, videoCanonico)
	require.NoError(t, err)
	w = servir(r, comTokenDoBot(pedidoJSON(t, http.MethodPost, "/api/acervo/paginas/"+pagina.ID+"/vaga", `{"bytes":10}`)))
	require.Equal(t, http.StatusNotFound, w.Code)
}

// O node diz O QUE aconteceu por um código de lista fechada; a frase que vai
// para o job de quem pediu nunca é texto dele.
func TestFalhaDoNodeUsaCodigoDeListaFechada(t *testing.T) {
	r, pool, cfg := montar(t, true)
	ctx := context.Background()
	dbtest.CriarUsuario(t, pool, "dono@exemplo.test")
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	jobs := acervo.NewJobs(pool)

	reivindicar := func() string {
		w := servir(r, comTokenDoBot(httptest.NewRequest(http.MethodPost, rotaReivindica, nil)))
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		return corpoDe(t, w)["id"].(string)
	}
	falhar := func(id, corpo string) *httptest.ResponseRecorder {
		return servir(r, comTokenDoBot(pedidoJSON(t, http.MethodPost, "/api/acervo/paginas/"+id+"/falha", corpo)))
	}

	_, _, err := jobs.EnfileirarPagina(ctx, eu, videoCanonico)
	require.NoError(t, err)
	id := reivindicar()

	require.Equal(t, http.StatusBadRequest, falhar(id, `{"code":"<b>texto livre</b>"}`).Code)

	// Falha que pode passar sozinha: volta para a fila.
	require.Equal(t, http.StatusOK, falhar(id, `{"code":"pagina_falhou"}`).Code)
	job, err := jobs.PorID(ctx, eu, id)
	require.NoError(t, err)
	require.Equal(t, "pending", job.Status)

	// Falha definitiva: encerra na hora, sem gastar as tentativas que sobram.
	require.Equal(t, id, reivindicar())
	require.Equal(t, http.StatusOK, falhar(id, `{"code":"pagina_indisponivel"}`).Code)
	w := servir(r, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/acervo/ingest/"+id, nil), eu))
	status := corpoDe(t, w)
	require.Equal(t, "error", status["status"])
	require.Equal(t, CodPaginaIndisponivel, status["code"])
}

func TestTetoDePedidosEmAndamentoPorConta(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	for i := 0; i < acervo.MaxAtivosPorConta; i++ {
		url := "https://exemplo.test/" + string(rune('a'+i)) + ".mp3"
		require.Equal(t, http.StatusAccepted, servir(r, comCookie(t, cfg, ingerirURL(t, url), eu)).Code)
	}
	w := servir(r, comCookie(t, cfg, ingerirURL(t, "https://exemplo.test/demais.mp3"), eu))
	require.Equal(t, http.StatusTooManyRequests, w.Code)
	require.Equal(t, CodMuitosPedidos, corpoDe(t, w)["code"])

	// Repetir um pedido que já existe não é pedido novo, e não vira 429.
	w = servir(r, comCookie(t, cfg, ingerirURL(t, "https://exemplo.test/a.mp3"), eu))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	// E o excedente não ficou ocupando a fila.
	ativos, err := acervo.NewJobs(pool).Ativos(context.Background(), eu)
	require.NoError(t, err)
	require.Equal(t, acervo.MaxAtivosPorConta, ativos)
}

// A cota recusa em todo caminho de entrada, sempre contra a conta que vai ser
// DONA da faixa — e deixa de recusar quando o admin desliga a chave.
func TestCotaRecusaFaixaNovaEmTodoCaminho(t *testing.T) {
	b := novoBucket()
	r, pool, cfg := montarComBucket(t, b)
	cfg.AdminTokenSHA256 = somaDoToken(tokenDoAdmin)
	ctx := context.Background()
	dono := dbtest.CriarUsuario(t, pool, "dono@exemplo.test") // a conta do bot
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	cheia := dbtest.CriarUsuario(t, pool, "cheia@exemplo.test")
	liberarParaOBot(t, pool, cheia)
	cotaDe(t, pool, eu, 1000)
	cotaDe(t, pool, cheia, 0)
	_ = dono

	recusado := func(w *httptest.ResponseRecorder, onde string) {
		t.Helper()
		require.Equal(t, http.StatusRequestEntityTooLarge, w.Code, "%s: %s", onde, w.Body.String())
		corpo := corpoDe(t, w)
		require.Equal(t, CodCotaExcedida, corpo["code"], onde)
		require.NotNil(t, corpo["params"], "%s: a recusa diz quanto há e quanto se usa", onde)
	}

	// 1. Pedido de vaga, pelo tamanho declarado.
	recusado(postJSON(t, r, cfg, "/api/acervo/upload", `{"bytes":2000}`, eu), "vaga")
	require.Equal(t, http.StatusOK, postJSON(t, r, cfg, "/api/acervo/upload", `{"bytes":500}`, eu).Code)

	// 2. Finalizar, pelo tamanho REAL: declarou 500, gravou 1500.
	w := postJSON(t, r, cfg, "/api/acervo/upload", `{"bytes":500}`, eu)
	envio := corpoDe(t, w)["id"].(string)
	key := storage.KeyUploadStage(eu, envio)
	b.semear(key, 1500)
	recusado(postJSON(t, r, cfg, "/api/acervo/upload/"+envio+"/finalizar", `{}`, eu), "finalizar")
	require.True(t, b.foiApagado(key), "o arquivo recusado sai do bucket")

	// 2b. Finalizar para OUTRA conta confere a cota do destino, não a de quem envia.
	w = postJSON(t, r, cfg, "/api/acervo/upload", `{"bytes":500}`, eu)
	envio = corpoDe(t, w)["id"].(string)
	b.semear(storage.KeyUploadStage(eu, envio), 500)
	recusado(postJSON(t, r, cfg, "/api/acervo/upload/"+envio+"/finalizar",
		`{"para":"cheia@exemplo.test"}`, eu), "finalizar para conta cheia")

	// 3. Ingestão por URL: conta no limite nem enfileira — pela sessão…
	recusado(servir(r, comCookie(t, cfg, ingerirURL(t, "https://exemplo.test/a.mp3"), cheia)), "ingest pela sessão")
	// …e o bot publicando PARA ela também.
	recusado(servir(r, comTokenDoBot(ingerirPara(t, "cheia@exemplo.test"))), "ingest do bot para conta cheia")

	// 4. O node: a vaga do arquivo baixado é recusada, e o job encerra de vez.
	w = servir(r, comCookie(t, cfg, ingerirURL(t, linkDoYouTube), eu))
	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())
	id := jobDaResposta(t, w)
	require.Equal(t, http.StatusOK, servir(r, comTokenDoBot(httptest.NewRequest(http.MethodPost, rotaReivindica, nil))).Code)
	recusado(servir(r, comTokenDoBot(pedidoJSON(t, http.MethodPost, "/api/acervo/paginas/"+id+"/vaga", `{"bytes":5000}`))), "vaga do node")
	job, err := acervo.NewJobs(pool).PorID(ctx, eu, id)
	require.NoError(t, err)
	require.Equal(t, "error", job.Status)
	require.Equal(t, admin.MensagemSemEspaco, job.Error)

	// Com a chave desligada pelo admin, nada disso recusa — vale no pedido seguinte.
	w = servir(r, comAdmin(pedidoJSON(t, http.MethodPut, "/api/admin/config", `{"cotaBloqueia":false}`)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, false, corpoDe(t, w)["cotaBloqueia"])
	require.Equal(t, http.StatusOK, postJSON(t, r, cfg, "/api/acervo/upload", `{"bytes":2000}`, eu).Code)
	require.Equal(t, http.StatusAccepted,
		servir(r, comCookie(t, cfg, ingerirURL(t, "https://exemplo.test/a.mp3"), cheia)).Code)
}

// Mexer numa chave da config não pode mexer na outra.
func TestConfigDoAdminMudaSoOQueVeio(t *testing.T) {
	r, _, _ := montarComAdmin(t) // cadastro aberto; cota bloqueando (o padrão da 0013)

	// As duas chaves que se GRAVAM. O que a config traz só para leitura (o teto
	// de envio padrão e o absoluto) tem o teste dele, logo abaixo.
	chaves := func(w *httptest.ResponseRecorder) map[string]any {
		corpo := corpoDe(t, w)
		return map[string]any{"cadastroAberto": corpo["cadastroAberto"], "cotaBloqueia": corpo["cotaBloqueia"]}
	}

	w := servir(r, comAdmin(httptest.NewRequest(http.MethodGet, "/api/admin/config", nil)))
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, map[string]any{"cadastroAberto": true, "cotaBloqueia": true}, chaves(w))

	w = servir(r, comAdmin(pedidoJSON(t, http.MethodPut, "/api/admin/config", `{"cotaBloqueia":false}`)))
	require.Equal(t, map[string]any{"cadastroAberto": true, "cotaBloqueia": false}, chaves(w))

	w = servir(r, comAdmin(pedidoJSON(t, http.MethodPut, "/api/admin/config", `{"cadastroAberto":false}`)))
	require.Equal(t, map[string]any{"cadastroAberto": false, "cotaBloqueia": false}, chaves(w))
}

// O painel precisa saber quanto é "o padrão" e até onde o teto por conta pode
// ir, para a tela não oferecer um número que o servidor vai recusar.
func TestConfigDoAdminTrazOsTetosDeEnvio(t *testing.T) {
	r, _, cfg := montarComAdmin(t)
	cfg.IngestMaxMB = 60

	w := servir(r, comAdmin(httptest.NewRequest(http.MethodGet, "/api/admin/config", nil)))
	require.Equal(t, http.StatusOK, w.Code)
	corpo := corpoDe(t, w)
	require.EqualValues(t, 60<<20, corpo["maxUploadPadraoBytes"])
	require.EqualValues(t, admin.MaxTetoDeEnvio, corpo["maxUploadTetoBytes"])
}

// O node recebe o teto de quem PEDIU o link, não o do servidor nem o da conta
// do bot: é ele que desiste antes de subir o que seria recusado.
func TestNodeRecebeOTetoDaContaQuePediuOLink(t *testing.T) {
	r, pool, cfg := montarComBucket(t, novoBucket())  // padrão de 10 MB
	dbtest.CriarUsuario(t, pool, "dono@exemplo.test") // a conta do bot
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	tetoDaConta(t, pool, eu, 50<<20)

	w := servir(r, comCookie(t, cfg, ingerirURL(t, linkDoYouTube), eu))
	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())
	id := jobDaResposta(t, w)

	w = servir(r, comTokenDoBot(httptest.NewRequest(http.MethodPost, rotaReivindica, nil)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.EqualValues(t, 50<<20, corpoDe(t, w)["maxBytes"])

	// 20 MB: acima do padrão do servidor, dentro do teto da conta.
	w = servir(r, comTokenDoBot(pedidoJSON(t, http.MethodPost, "/api/acervo/paginas/"+id+"/vaga", `{"bytes":20971520}`)))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.EqualValues(t, 50<<20, corpoDe(t, w)["maxBytes"])

	// 60 MB: acima do teto da conta.
	w = servir(r, comTokenDoBot(pedidoJSON(t, http.MethodPost, "/api/acervo/paginas/"+id+"/vaga", `{"bytes":62914560}`)))
	require.Equal(t, http.StatusRequestEntityTooLarge, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "50 MB")
}

// Os dois erros do worker que carregam número ou nome de codec saíam sem código.
func TestErroDoWorkerComParametroGanhaCodigo(t *testing.T) {
	require.Equal(t, CodIngestGrandeDemais, codigoDoJob("arquivo maior que o limite de 62914560 bytes"))
	require.Equal(t, CodIngestFormato, codigoDoJob("formato que o navegador não toca: wmav2"))
	require.Equal(t, CodIngestSemAudio, codigoDoJob("o arquivo não tem faixa de áudio"))
	require.Empty(t, codigoDoJob("frase que ninguém conhece"))
}

// --- faixa repetida (migração 0014) ---

// faixaComOrigem grava uma faixa pronta que veio deste link, como o worker faz.
func faixaComOrigem(t *testing.T, pool *pgxpool.Pool, dono, id, origem string) {
	t.Helper()
	_, err := acervo.NewTracks(pool).Criar(context.Background(), acervo.Nova{
		ID: id, UserID: dono, Title: "The Door", Artist: "Teddy Swims", Genre: "acervo",
		DurS: 212, AudioKey: "u/" + dono + "/a/" + id + ".mp3", AudioType: "audio/mpeg",
		SizeBytes: 1000, OrigemURL: origem,
	})
	require.NoError(t, err)
}

// O link que a conta já trouxe nem enfileira: a recusa barata, sem download.
func TestLinkQueAContaJaTrouxeEhRecusadoNaEntrada(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	outra := dbtest.CriarUsuario(t, pool, "outra@exemplo.test")
	faixaComOrigem(t, pool, eu, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", videoCanonico)

	// Colado de outro jeito, é o mesmo vídeo.
	w := servir(r, comCookie(t, cfg, ingerirURL(t, linkDoYouTube), eu))
	require.Equal(t, http.StatusConflict, w.Code, w.Body.String())
	corpo := corpoDe(t, w)
	require.Equal(t, CodFaixaRepetida, corpo["code"])
	require.Equal(t, "The Door", corpo["params"].(map[string]any)["titulo"])

	ativos, err := acervo.NewJobs(pool).Ativos(context.Background(), eu)
	require.NoError(t, err)
	require.Zero(t, ativos, "nada foi enfileirado")

	// É por conta: a outra pessoa pode trazer o mesmo link.
	w = servir(r, comCookie(t, cfg, ingerirURL(t, linkDoYouTube), outra))
	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())

	// E apagada a faixa, o link volta a valer.
	_, err = acervo.NewTracks(pool).Remover(context.Background(), eu, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	require.NoError(t, err)
	w = servir(r, comCookie(t, cfg, ingerirURL(t, linkDoYouTube), eu))
	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())
}

// Depois que o node entrega o arquivo, a fonte do job vira `upload:<id>` e o
// índice de dedupe deixa de reconhecer o link. Colar de novo nessa janela tem
// de devolver o MESMO pedido, não abrir um segundo download.
func TestLinkEmAndamentoDevolveOMesmoPedidoMesmoDepoisDaEntrega(t *testing.T) {
	r, pool, cfg := montar(t, true)
	ctx := context.Background()
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	jobs := acervo.NewJobs(pool)

	w := servir(r, comCookie(t, cfg, ingerirURL(t, linkDoYouTube), eu))
	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())
	id := corpoDe(t, w)["id"].(string)

	_, err := jobs.ReivindicarPagina(ctx)
	require.NoError(t, err)
	_, err = jobs.EntregarPagina(ctx, id, "11111111-1111-4111-8111-111111111111", "The Door", "Teddy Swims", "the-door.mp3")
	require.NoError(t, err)

	w = servir(r, comCookie(t, cfg, ingerirURL(t, linkDoYouTube), eu))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, id, corpoDe(t, w)["id"])

	ativos, err := jobs.Ativos(ctx, eu)
	require.NoError(t, err)
	require.Equal(t, 1, ativos)
}

// O job que o worker recusou por repetição chega à PWA com código, não com a
// frase crua em pt-BR.
func TestJobRecusadoPorRepeticaoTemCodigo(t *testing.T) {
	require.Equal(t, CodFaixaRepetida, codigoDoJob(acervo.MensagemRepetida))
}
