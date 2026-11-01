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

// semearFaixaDe cria uma faixa de um dono qualquer, com visibilidade escolhida.
func semearFaixaDe(t *testing.T, pool interface{ Close() }, tracks *acervo.Tracks, dono, id, titulo, vis string) {
	t.Helper()
	_, err := tracks.Criar(context.Background(), acervo.Nova{
		ID: id, UserID: dono, Title: titulo, Artist: "a", Genre: "acervo", DurS: 10,
		AudioKey: "u/" + dono + "/a/" + id + ".mp3", AudioType: "audio/mpeg", SizeBytes: 1,
		Visibilidade: vis,
	})
	require.NoError(t, err)
}

func listar(t *testing.T, r http.Handler, cfg interface{}, req *http.Request) []map[string]any {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	var corpo struct{ Tracks []map[string]any }
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &corpo))
	return corpo.Tracks
}

func titulos(faixas []map[string]any) []string {
	saida := make([]string, 0, len(faixas))
	for _, f := range faixas {
		saida = append(saida, fmt.Sprint(f["title"]))
	}
	return saida
}

func patchCompartilhamento(t *testing.T, id, corpo string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPatch, "/api/acervo/"+id+"/compartilhamento",
		strings.NewReader(corpo))
	req.Header.Set("Content-Type", "application/json")
	return req
}

const (
	faixaA = "11111111-1111-4111-8111-111111111111"
	faixaB = "22222222-2222-4222-8222-222222222222"
)

// O teste central: `todos` é regra viva, e a faixa não só APARECE para a outra
// conta — ela TOCA. São duas coisas e dois caminhos de código: a listagem usa
// `Listar`, e o play passa por `PorIDAudivel`. Trocar o segundo de volta por
// `PorID` deixa a faixa visível e morta.
func TestFaixaDeTodosApareceEtocaParaAOutraConta(t *testing.T) {
	r, pool, cfg := montar(t, true)
	tracks := acervo.NewTracks(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	outro := dbtest.CriarUsuario(t, pool, "outro@exemplo.test")
	semearFaixaDe(t, pool, tracks, eu, faixaA, "para todos", acervo.VisibilidadeTodos)

	faixas := listar(t, r, cfg, comCookie(t, cfg,
		httptest.NewRequest(http.MethodGet, "/api/acervo", nil), outro))
	require.Equal(t, []string{"para todos"}, titulos(faixas))

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg,
		httptest.NewRequest(http.MethodGet, "/api/acervo/"+faixaA+"/audio", nil), outro))
	require.Equal(t, http.StatusFound, w.Code, "faixa de `todos` tem de tocar para quem não é dono")
	require.Contains(t, w.Header().Get("Location"), faixaA)
}

func TestFaixaPrivadaNaoApareceNemTocaParaOutraConta(t *testing.T) {
	r, pool, cfg := montar(t, true)
	tracks := acervo.NewTracks(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	outro := dbtest.CriarUsuario(t, pool, "outro@exemplo.test")
	semearFaixaDe(t, pool, tracks, eu, faixaA, "minha e só minha", acervo.VisibilidadePrivada)

	faixas := listar(t, r, cfg, comCookie(t, cfg,
		httptest.NewRequest(http.MethodGet, "/api/acervo", nil), outro))
	require.Empty(t, faixas)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg,
		httptest.NewRequest(http.MethodGet, "/api/acervo/"+faixaA+"/audio", nil), outro))
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestConcessaoNominalApareceSoParaQuemRecebeu(t *testing.T) {
	r, pool, cfg := montar(t, true)
	tracks := acervo.NewTracks(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	convidado := dbtest.CriarUsuario(t, pool, "convidado@exemplo.test")
	estranho := dbtest.CriarUsuario(t, pool, "estranho@exemplo.test")
	semearFaixaDe(t, pool, tracks, eu, faixaA, "para um", acervo.VisibilidadePrivada)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg,
		patchCompartilhamento(t, faixaA, `{"com":["convidado@exemplo.test"]}`), eu))
	require.Equal(t, http.StatusOK, w.Code)

	// A resposta é o estado inteiro, e fala em NOME e nunca em e-mail.
	var estado struct {
		Visibilidade string   `json:"visibilidade"`
		Com          []string `json:"com"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &estado))
	require.Equal(t, acervo.VisibilidadePrivada, estado.Visibilidade)
	require.Equal(t, []string{"convidado"}, estado.Com)
	require.NotContains(t, w.Body.String(), "@", "a resposta não devolve e-mail de ninguém")

	require.Equal(t, []string{"para um"}, titulos(listar(t, r, cfg, comCookie(t, cfg,
		httptest.NewRequest(http.MethodGet, "/api/acervo", nil), convidado))))
	require.Empty(t, listar(t, r, cfg, comCookie(t, cfg,
		httptest.NewRequest(http.MethodGet, "/api/acervo", nil), estranho)))
}

// Vem de graça — `Remover` filtra por dono no SQL e não foi tocado —, e por ser
// de graça é que precisa de teste: nada no código diz em voz alta que o
// destinatário não apaga.
func TestODestinatarioNaoApagaAFaixaQueNaoEDele(t *testing.T) {
	r, pool, cfg := montar(t, true)
	tracks := acervo.NewTracks(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	outro := dbtest.CriarUsuario(t, pool, "outro@exemplo.test")
	semearFaixaDe(t, pool, tracks, eu, faixaA, "para todos", acervo.VisibilidadeTodos)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg,
		httptest.NewRequest(http.MethodDelete, "/api/acervo/"+faixaA, nil), outro))
	require.Equal(t, http.StatusNotFound, w.Code, "quem recebeu não apaga a faixa de quem mandou")

	// E continua lá, para o 404 não ter sido "a faixa já não existia".
	require.Len(t, listar(t, r, cfg, comCookie(t, cfg,
		httptest.NewRequest(http.MethodGet, "/api/acervo", nil), eu)), 1)

	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg,
		httptest.NewRequest(http.MethodDelete, "/api/acervo/"+faixaA, nil), eu))
	require.Equal(t, http.StatusOK, w.Code, "o dono apaga")
}

// A FK de `track_shares` faz a limpeza das concessões; a curtida precisa do
// `RemoverFaixa`, que apaga por faixa e SEM dono. Era detalhe antes de existir
// faixa compartilhada; agora é requisito — a curtida de quem recebeu tem de sair
// junto, senão sobra linha apontando para uma faixa que não existe.
func TestApagarAFaixaLevaAsConcessoesEAsCurtidasDeTodos(t *testing.T) {
	r, pool, cfg := montar(t, true)
	ctx := context.Background()
	tracks := acervo.NewTracks(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	convidado := dbtest.CriarUsuario(t, pool, "convidado@exemplo.test")
	semearFaixaDe(t, pool, tracks, eu, faixaA, "compartilhada", acervo.VisibilidadePrivada)

	_, _, err := tracks.AplicarCompartilhamento(ctx, eu, faixaA, "", []string{convidado}, nil)
	require.NoError(t, err)

	// Os dois curtem a mesma faixa.
	for _, quem := range []string{eu, convidado} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, comCookie(t, cfg,
			patchLikes(t, `{"add":["acervo:`+faixaA+`"],"remove":[]}`), quem))
		require.Equal(t, http.StatusOK, w.Code)
	}

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg,
		httptest.NewRequest(http.MethodDelete, "/api/acervo/"+faixaA, nil), eu))
	require.Equal(t, http.StatusOK, w.Code)

	var concessoes int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM track_shares WHERE track_id = $1`, faixaA).Scan(&concessoes))
	require.Zero(t, concessoes, "a FK tinha de levar a concessão junto")

	var curtidas int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM likes WHERE track_id = $1`, prefixoID+faixaA).Scan(&curtidas))
	require.Zero(t, curtidas, "a curtida de QUALQUER conta tinha de sair junto")
}

func TestQuemNaoEDonoNaoMudaVisibilidade(t *testing.T) {
	r, pool, cfg := montar(t, true)
	ctx := context.Background()
	tracks := acervo.NewTracks(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	outro := dbtest.CriarUsuario(t, pool, "outro@exemplo.test")
	// `todos` de propósito: o outro CONSEGUE ouvir esta faixa, e mesmo assim
	// não pode mexer nela. É a prova de que ouvir e mexer são dois direitos.
	semearFaixaDe(t, pool, tracks, eu, faixaA, "para todos", acervo.VisibilidadeTodos)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg,
		patchCompartilhamento(t, faixaA, `{"visibilidade":"privada"}`), outro))
	require.Equal(t, http.StatusNotFound, w.Code, "404 e não 403: para quem não é dono, a faixa não existe")

	vis, _, err := tracks.Compartilhamento(ctx, eu, faixaA)
	require.NoError(t, err)
	require.Equal(t, acervo.VisibilidadeTodos, vis, "a visibilidade não podia ter mudado")
}

// `owner` é o que separa `--acervo` de `--compartilhadas` na PWA, pela AUSÊNCIA
// dele. Mandá-lo também na faixa própria apagaria a distinção, e os dois
// recortes mostrariam a mesma coisa.
func TestOwnerSaiSoNaFaixaAlheiaEVisibilidadeSoNaPropria(t *testing.T) {
	r, pool, cfg := montar(t, true)
	tracks := acervo.NewTracks(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	outro := dbtest.CriarUsuario(t, pool, "outro@exemplo.test")
	semearFaixaDe(t, pool, tracks, eu, faixaA, "minha", acervo.VisibilidadeTodos)
	semearFaixaDe(t, pool, tracks, outro, faixaB, "dele", acervo.VisibilidadeTodos)

	porTitulo := map[string]map[string]any{}
	for _, f := range listar(t, r, cfg, comCookie(t, cfg,
		httptest.NewRequest(http.MethodGet, "/api/acervo", nil), eu)) {
		porTitulo[fmt.Sprint(f["title"])] = f
	}
	require.Len(t, porTitulo, 2)

	require.NotContains(t, porTitulo["minha"], "owner", "a faixa própria não leva dono")
	require.Equal(t, acervo.VisibilidadeTodos, porTitulo["minha"]["visibilidade"])

	require.Equal(t, "outro", porTitulo["dele"]["owner"], "é o nome de exibição, não o e-mail")
	require.NotContains(t, porTitulo["dele"], "visibilidade",
		"visibilidade é escolha do dono e não diz nada a quem recebeu")
}

// --- destino na ingestão ---

func ingerirPara(t *testing.T, para string) *http.Request {
	t.Helper()
	corpo := fmt.Sprintf(`{"url":"https://exemplo.test/a.mp3","para":%q}`, para)
	req := httptest.NewRequest(http.MethodPost, "/api/acervo/ingest", strings.NewReader(corpo))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func jobDaResposta(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var corpo struct {
		ID string `json:"id"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &corpo))
	require.NotEmpty(t, corpo.ID)
	return corpo.ID
}

func TestIngestaoComDestinoDeEmailMarcaOJobParaAContaDoDestino(t *testing.T) {
	r, pool, cfg := montar(t, true)
	ctx := context.Background()
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	destino := dbtest.CriarUsuario(t, pool, "destino@exemplo.test")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, ingerirPara(t, "destino@exemplo.test"), eu))
	require.Equal(t, http.StatusAccepted, w.Code)

	// `user_id` continua sendo QUEM PEDIU — é ele que reconstrói a key da área
	// de espera e que lê o status. O destino é um campo à parte.
	job, err := acervo.NewJobs(pool).PorID(ctx, eu, jobDaResposta(t, w))
	require.NoError(t, err)
	require.Equal(t, eu, job.UserID)
	require.Equal(t, destino, job.DestinoID)
	require.Equal(t, acervo.VisibilidadePrivada, job.Visibilidade)
}

func TestIngestaoParaTodosFicaComQuemPediuEMarcadaTodos(t *testing.T) {
	r, pool, cfg := montar(t, true)
	ctx := context.Background()
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, ingerirPara(t, "todos"), eu))
	require.Equal(t, http.StatusAccepted, w.Code)

	job, err := acervo.NewJobs(pool).PorID(ctx, eu, jobDaResposta(t, w))
	require.NoError(t, err)
	require.Empty(t, job.DestinoID, "`todos` é propriedade da faixa, não uma pessoa")
	require.Equal(t, acervo.VisibilidadeTodos, job.Visibilidade)
}

func TestIngestaoSemDestinoContinuaPrivadaEDeQuemPediu(t *testing.T) {
	r, pool, cfg := montar(t, true)
	ctx := context.Background()
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, ingerirPara(t, ""), eu))
	require.Equal(t, http.StatusAccepted, w.Code)

	job, err := acervo.NewJobs(pool).PorID(ctx, eu, jobDaResposta(t, w))
	require.NoError(t, err)
	require.Empty(t, job.DestinoID)
	require.Equal(t, acervo.VisibilidadePrivada, job.Visibilidade)
}

// O teste da ENUMERAÇÃO, e é por isso que ele compara os corpos das duas
// respostas em vez de só conferir dois 400. Se o token pudesse distinguir
// "fora da lista" de "não existe", ele descobriria quem tem conta tentando
// e-mail por e-mail.
func TestTokenNaoDistingueDestinoForaDaListaDeDestinoInexistente(t *testing.T) {
	r, pool, cfg := montar(t, true)
	dbtest.CriarUsuario(t, pool, "dono@exemplo.test")
	// Existe, tem conta, e NÃO está em INGEST_DESTINOS.
	dbtest.CriarUsuario(t, pool, "forade@exemplo.test")
	cfg.IngestDestinos = "liberado@exemplo.test"

	respostas := map[string]string{}
	for _, email := range []string{"forade@exemplo.test", "nao-existe@exemplo.test"} {
		req := ingerirPara(t, email)
		req.Header.Set("X-Ondas-Token", tokenDoBot)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusBadRequest, w.Code, email)
		respostas[email] = w.Body.String()
	}
	require.Equal(t, respostas["forade@exemplo.test"], respostas["nao-existe@exemplo.test"],
		"as duas recusas têm de ser indistinguíveis")
}

func TestTokenPublicaParaODestinoQueEstaNaLista(t *testing.T) {
	r, pool, cfg := montar(t, true)
	ctx := context.Background()
	dono := dbtest.CriarUsuario(t, pool, "dono@exemplo.test")
	liberado := dbtest.CriarUsuario(t, pool, "liberado@exemplo.test")
	cfg.IngestDestinos = "liberado@exemplo.test"

	req := ingerirPara(t, "liberado@exemplo.test")
	req.Header.Set("X-Ondas-Token", tokenDoBot)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusAccepted, w.Code)

	job, err := acervo.NewJobs(pool).PorID(ctx, dono, jobDaResposta(t, w))
	require.NoError(t, err)
	require.Equal(t, liberado, job.DestinoID)
}

// Com a lista VAZIA — o padrão, e o estado da API recém-subida antes do
// ConfigMap — o token não alcança destino nenhum. É o que deixa o passo 1 subir
// sozinho sem mudar comportamento.
func TestListaDeDestinosVaziaFechaOCaminhoDoToken(t *testing.T) {
	r, pool, cfg := montar(t, true)
	dbtest.CriarUsuario(t, pool, "dono@exemplo.test")
	dbtest.CriarUsuario(t, pool, "alguem@exemplo.test")
	require.Empty(t, cfg.IngestDestinos)

	req := ingerirPara(t, "alguem@exemplo.test")
	req.Header.Set("X-Ondas-Token", tokenDoBot)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)

	// E `todos` continua valendo: ele não nomeia conta nenhuma, então não passa
	// pela lista.
	req = ingerirPara(t, "todos")
	req.Header.Set("X-Ondas-Token", tokenDoBot)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusAccepted, w.Code)
}

// Sessão NÃO passa pela lista do token: limitar um robô e limitar gente são
// decisões diferentes.
func TestSessaoPublicaParaQualquerContaMesmoForaDaLista(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	dbtest.CriarUsuario(t, pool, "forade@exemplo.test")
	cfg.IngestDestinos = "so-este@exemplo.test"

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, ingerirPara(t, "forade@exemplo.test"), eu))
	require.Equal(t, http.StatusAccepted, w.Code)
}

// O índice de dedupe da 0002 dizia "a mesma URL não entra duas vezes". Com
// destino, a mesma URL para duas pessoas são dois pedidos legítimos — sem o
// destino no índice, o segundo receberia o job do primeiro e a faixa iria para
// o lugar errado, em silêncio, com um 200 que parece certo.
func TestAMesmaURLParaDoisDestinosGeraDoisJobs(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	dbtest.CriarUsuario(t, pool, "um@exemplo.test")
	dbtest.CriarUsuario(t, pool, "dois@exemplo.test")

	vistos := map[string]bool{}
	for _, destino := range []string{"um@exemplo.test", "dois@exemplo.test", "todos", ""} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, comCookie(t, cfg, ingerirPara(t, destino), eu))
		require.Equal(t, http.StatusAccepted, w.Code, "destino %q devia ser pedido novo", destino)
		vistos[jobDaResposta(t, w)] = true
	}
	require.Len(t, vistos, 4, "quatro destinos, quatro jobs")

	// E a dedupe original continua de pé: repetir o MESMO destino não cria um
	// segundo job.
	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, ingerirPara(t, "um@exemplo.test"), eu))
	require.Equal(t, http.StatusOK, w.Code, "200 e não 202: nada novo foi aceito")
}

func TestOMesmoDestinoEmComESemERecusado(t *testing.T) {
	r, pool, cfg := montar(t, true)
	tracks := acervo.NewTracks(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	dbtest.CriarUsuario(t, pool, "convidado@exemplo.test")
	semearFaixaDe(t, pool, tracks, eu, faixaA, "minha", acervo.VisibilidadePrivada)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg, patchCompartilhamento(t, faixaA,
		`{"com":["convidado@exemplo.test"],"sem":["convidado@exemplo.test"]}`), eu))
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestVisibilidadeDesconhecidaERecusadaAntesDoBanco(t *testing.T) {
	r, pool, cfg := montar(t, true)
	tracks := acervo.NewTracks(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	semearFaixaDe(t, pool, tracks, eu, faixaA, "minha", acervo.VisibilidadePrivada)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg,
		patchCompartilhamento(t, faixaA, `{"visibilidade":"semi-publica"}`), eu))
	require.Equal(t, http.StatusBadRequest, w.Code,
		"400 e não 500: valor fora do CHECK é pedido malformado, não falha de banco")
}

// Tirar a concessão fecha a porta de novo — inclusive para tocar, e não só para
// listar.
func TestDescompartilharTiraAFaixaDaListaEDoPlay(t *testing.T) {
	r, pool, cfg := montar(t, true)
	tracks := acervo.NewTracks(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	convidado := dbtest.CriarUsuario(t, pool, "convidado@exemplo.test")
	semearFaixaDe(t, pool, tracks, eu, faixaA, "emprestada", acervo.VisibilidadePrivada)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg,
		patchCompartilhamento(t, faixaA, `{"com":["convidado@exemplo.test"]}`), eu))
	require.Equal(t, http.StatusOK, w.Code)
	require.Len(t, listar(t, r, cfg, comCookie(t, cfg,
		httptest.NewRequest(http.MethodGet, "/api/acervo", nil), convidado)), 1)

	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg,
		patchCompartilhamento(t, faixaA, `{"sem":["convidado@exemplo.test"]}`), eu))
	require.Equal(t, http.StatusOK, w.Code)
	var estado struct {
		Com []string `json:"com"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &estado))
	require.Empty(t, estado.Com)

	require.Empty(t, listar(t, r, cfg, comCookie(t, cfg,
		httptest.NewRequest(http.MethodGet, "/api/acervo", nil), convidado)))

	w = httptest.NewRecorder()
	r.ServeHTTP(w, comCookie(t, cfg,
		httptest.NewRequest(http.MethodGet, "/api/acervo/"+faixaA+"/audio", nil), convidado))
	require.Equal(t, http.StatusNotFound, w.Code)
}

// Apagar a conta de quem RECEBEU não pode levar a faixa de quem mandou: o
// CASCADE de `track_shares` é sobre a concessão, não sobre a música.
func TestApagarAContaDeQuemRecebeuNaoApagaAFaixaDeQuemMandou(t *testing.T) {
	r, pool, cfg := montar(t, true)
	ctx := context.Background()
	tracks := acervo.NewTracks(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	convidado := dbtest.CriarUsuario(t, pool, "convidado@exemplo.test")
	semearFaixaDe(t, pool, tracks, eu, faixaA, "minha", acervo.VisibilidadePrivada)

	_, _, err := tracks.AplicarCompartilhamento(ctx, eu, faixaA, "", []string{convidado}, nil)
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, convidado)
	require.NoError(t, err)

	require.Equal(t, []string{"minha"}, titulos(listar(t, r, cfg, comCookie(t, cfg,
		httptest.NewRequest(http.MethodGet, "/api/acervo", nil), eu))))
	vis, com, err := tracks.Compartilhamento(ctx, eu, faixaA)
	require.NoError(t, err)
	require.Equal(t, acervo.VisibilidadePrivada, vis)
	require.Empty(t, com, "a concessão saiu com a conta")
}
