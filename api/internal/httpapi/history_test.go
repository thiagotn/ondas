package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/thiagotn/ondas/api/internal/acervo"
	"github.com/thiagotn/ondas/api/internal/config"
	"github.com/thiagotn/ondas/api/internal/dbtest"
	"github.com/thiagotn/ondas/api/internal/history"
)

func pedidoJSON(t *testing.T, metodo, rota, corpo string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(metodo, rota, strings.NewReader(corpo))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func putMarcador(t *testing.T, id string, pos float64, em time.Time) *http.Request {
	t.Helper()
	return pedidoJSON(t, http.MethodPut, "/api/playback",
		fmt.Sprintf(`{"trackId":%q,"pos":%g,"dur":200,"em":%d}`, id, pos, em.UnixMilli()))
}

// marcadorDe lê a resposta das duas rotas do marcador, que têm o mesmo formato.
func marcadorDe(t *testing.T, w *httptest.ResponseRecorder) *marcadorJSON {
	t.Helper()
	var corpo struct {
		Marcador *marcadorJSON `json:"marcador"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &corpo))
	return corpo.Marcador
}

func itensDe(t *testing.T, w *httptest.ResponseRecorder) []itemJSON {
	t.Helper()
	var corpo struct {
		Itens []itemJSON `json:"itens"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &corpo))
	return corpo.Itens
}

func idsDosItens(itens []itemJSON) []string {
	ids := make([]string, 0, len(itens))
	for _, it := range itens {
		ids = append(ids, it.TrackID)
	}
	return ids
}

func servir(r http.Handler, req *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func postHistorico(t *testing.T, itens ...itemJSON) *http.Request {
	t.Helper()
	corpo, err := json.Marshal(map[string]any{"itens": itens})
	require.NoError(t, err)
	return pedidoJSON(t, http.MethodPost, "/api/history", string(corpo))
}

func TestQuemNuncaOuviuNadaTemMarcadorNuloEHistoricoVazio(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	w := servir(r, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/playback", nil), eu))
	require.Equal(t, http.StatusOK, w.Code, "200 com null, e não 404: 404 é o que a PWA vê de uma API antiga")
	require.Nil(t, marcadorDe(t, w))
	require.Equal(t, "private, no-store", w.Header().Get("Cache-Control"))

	w = servir(r, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/history", nil), eu))
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), `"itens":[]`, "lista vazia é [] e não null")
	require.Equal(t, "private, no-store", w.Header().Get("Cache-Control"))
}

func TestOMarcadorGravadoEOMarcadorLido(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	quando := time.Now().Add(-time.Minute)

	w := servir(r, comCookie(t, cfg, putMarcador(t, "demo1", 42.5, quando), eu))
	require.Equal(t, http.StatusOK, w.Code)

	w = servir(r, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/playback", nil), eu))
	m := marcadorDe(t, w)
	require.NotNil(t, m)
	require.Equal(t, "demo1", m.TrackID)
	require.InDelta(t, 42.5, m.Pos, 0.001)
	require.InDelta(t, 200, m.Dur, 0.001)
	require.Equal(t, quando.UnixMilli(), m.Em, "o carimbo é o de quem ouviu, não o da chegada")
}

// A regra de conflito entre aparelhos, e o teste que cai se o
// `WHERE playback.em <= EXCLUDED.em` sair do upsert: a escrita que chega
// ATRASADA — ficou numa aba sem rede — não passa por cima da que o outro
// aparelho já fez. Quem decide é o instante em que o som saiu, não a ordem de
// chegada.
func TestMarcadorMaisVelhoNaoSobrescreveOMaisNovo(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	agora := time.Now()

	w := servir(r, comCookie(t, cfg, putMarcador(t, "do-celular", 90, agora.Add(-10*time.Minute)), eu))
	require.Equal(t, http.StatusOK, w.Code)

	// O desktop ficou sem rede e só agora sobe o que ouviu há duas horas.
	w = servir(r, comCookie(t, cfg, putMarcador(t, "do-desktop", 15, agora.Add(-2*time.Hour)), eu))
	require.Equal(t, http.StatusOK, w.Code, "escrita ignorada não é erro")
	m := marcadorDe(t, w)
	require.NotNil(t, m)
	require.Equal(t, "do-celular", m.TrackID, "a resposta é o marcador que FICOU, e é por ela que o cliente sabe que perdeu")

	// E o mais novo passa.
	w = servir(r, comCookie(t, cfg, putMarcador(t, "do-desktop", 20, agora.Add(-time.Minute)), eu))
	require.Equal(t, "do-desktop", marcadorDe(t, w).TrackID)
}

// O carimbo é do relógio do aparelho. Sem o `LEAST(em, now())`, um aparelho com
// a data adiantada gravaria um marcador que nenhuma escrita honesta superaria —
// a conta ficaria presa àquela faixa para sempre.
func TestCarimboNoFuturoELimitadoAoAgora(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	w := servir(r, comCookie(t, cfg, putMarcador(t, "relogio-adiantado", 10, time.Now().Add(240*time.Hour)), eu))
	require.Equal(t, http.StatusOK, w.Code)
	require.LessOrEqual(t, marcadorDe(t, w).Em, time.Now().Add(time.Second).UnixMilli())

	// Postgres guarda microssegundos; um respiro garante que "agora" já passou.
	time.Sleep(5 * time.Millisecond)
	w = servir(r, comCookie(t, cfg, putMarcador(t, "relogio-certo", 30, time.Now()), eu))
	require.Equal(t, "relogio-certo", marcadorDe(t, w).TrackID, "o relógio certo tinha de conseguir gravar por cima")
}

func TestMarcadorEHistoricoSaoPorConta(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	outro := dbtest.CriarUsuario(t, pool, "outro@exemplo.test")
	agora := time.Now().Add(-time.Minute)

	require.Equal(t, http.StatusOK, servir(r, comCookie(t, cfg, putMarcador(t, "minha", 5, agora), eu)).Code)
	require.Equal(t, http.StatusOK, servir(r, comCookie(t, cfg,
		postHistorico(t, itemJSON{TrackID: "minha", Titulo: "Minha", Artista: "eu", Dur: 100, Em: agora.UnixMilli()}), eu)).Code)

	w := servir(r, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/playback", nil), outro))
	require.Nil(t, marcadorDe(t, w), "o marcador de um não aparece para o outro")
	w = servir(r, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/history", nil), outro))
	require.Empty(t, itensDe(t, w))

	// E a escrita do outro não encosta na minha.
	require.Equal(t, http.StatusOK, servir(r, comCookie(t, cfg, putMarcador(t, "dele", 7, time.Now()), outro)).Code)
	w = servir(r, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/playback", nil), eu))
	require.Equal(t, "minha", marcadorDe(t, w).TrackID)
}

// O que alguém ouviu é da conta, e só a sessão lê ou muda. Mesma divisão de
// `TestCurtidasExigemSessaoENaoAceitamToken`: mover uma destas rotas para um
// grupo com token compila e passa no resto da suíte; só este teste denuncia.
func TestMarcadorEHistoricoExigemSessaoENaoAceitamToken(t *testing.T) {
	r, pool, _ := montar(t, true)
	dbtest.CriarUsuario(t, pool, "dono@exemplo.test")

	pedidos := func() []*http.Request {
		return []*http.Request{
			httptest.NewRequest(http.MethodGet, "/api/playback", nil),
			putMarcador(t, "x", 1, time.Now()),
			httptest.NewRequest(http.MethodGet, "/api/history", nil),
			postHistorico(t, itemJSON{TrackID: "x", Titulo: "x", Em: time.Now().UnixMilli()}),
			httptest.NewRequest(http.MethodDelete, "/api/history", nil),
		}
	}
	for _, req := range pedidos() {
		require.Equal(t, http.StatusUnauthorized, servir(r, req).Code,
			"%s %s sem cookie não passa", req.Method, req.URL.Path)
	}
	for _, req := range pedidos() {
		req.Header.Set("X-Ondas-Token", tokenDoBot)
		require.Equal(t, http.StatusUnauthorized, servir(r, req).Code,
			"o token do bot não abre %s %s", req.Method, req.URL.Path)
	}
}

func TestMarcadorInvalidoNaoPassa(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	for nome, corpo := range map[string]string{
		"sem id":             `{"trackId":"","pos":1,"dur":2,"em":1}`,
		"id gigante":         `{"trackId":"` + strings.Repeat("x", maxTamanhoID+1) + `","pos":1,"dur":2,"em":1}`,
		"posição negativa":   `{"trackId":"a","pos":-1,"dur":2,"em":1}`,
		"posição absurda":    `{"trackId":"a","pos":1e12,"dur":2,"em":1}`,
		"sem carimbo":        `{"trackId":"a","pos":1,"dur":2}`,
		"campo desconhecido": `{"trackId":"a","pos":1,"dur":2,"em":1,"fila":[]}`,
	} {
		w := servir(r, comCookie(t, cfg, pedidoJSON(t, http.MethodPut, "/api/playback", corpo), eu))
		require.Equal(t, http.StatusBadRequest, w.Code, nome)
	}
}

// Uma linha por faixa: ouvir de novo move a data e leva a faixa para o topo, em
// vez de empilhar a mesma música cinco vezes para quem a deixou em repetição.
func TestOuvirDeNovoSobeAFaixaENaoDuplica(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	base := time.Now().Add(-time.Hour)

	w := servir(r, comCookie(t, cfg, postHistorico(t,
		itemJSON{TrackID: "a", Titulo: "A", Artista: "x", Dur: 10, Em: base.UnixMilli()},
		itemJSON{TrackID: "b", Titulo: "B", Artista: "x", Dur: 10, Em: base.Add(time.Minute).UnixMilli()},
	), eu))
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, []string{"b", "a"}, idsDosItens(itensDe(t, w)), "mais recente primeiro")

	w = servir(r, comCookie(t, cfg, postHistorico(t,
		itemJSON{TrackID: "a", Titulo: "A (remaster)", Artista: "x", Dur: 11, Em: base.Add(2 * time.Minute).UnixMilli()},
	), eu))
	itens := itensDe(t, w)
	require.Equal(t, []string{"a", "b"}, idsDosItens(itens), "a faixa ouvida de novo sobe, e continua sendo uma linha só")
	require.Equal(t, "A (remaster)", itens[0].Titulo, "o retrato acompanha a escuta mais recente")
	require.Equal(t, 11, itens[0].Dur)

	// A fila que subiu atrasada não faz a faixa parecer ouvida antes do que foi.
	w = servir(r, comCookie(t, cfg, postHistorico(t,
		itemJSON{TrackID: "a", Titulo: "A", Artista: "x", Dur: 10, Em: base.Add(-time.Hour).UnixMilli()},
	), eu))
	require.Equal(t, []string{"a", "b"}, idsDosItens(itensDe(t, w)), "a data não anda para trás")
}

// Cai sem o dedupe do handler: a mesma faixa duas vezes no lote são dois
// upserts na mesma linha, e o que ficaria gravado dependeria da ordem em que
// vieram. A fila do cliente não deveria mandar repetido — este teste é para o
// dia em que mandar.
func TestLoteComIdRepetidoFicaComAEscutaMaisRecente(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	base := time.Now().Add(-time.Hour)

	w := servir(r, comCookie(t, cfg, postHistorico(t,
		itemJSON{TrackID: "a", Titulo: "nova", Artista: "x", Dur: 10, Em: base.Add(time.Minute).UnixMilli()},
		itemJSON{TrackID: "a", Titulo: "velha", Artista: "x", Dur: 10, Em: base.UnixMilli()},
	), eu))
	require.Equal(t, http.StatusOK, w.Code)
	itens := itensDe(t, w)
	require.Len(t, itens, 1)
	require.Equal(t, "nova", itens[0].Titulo, "vale a escuta mais recente, venha em que ordem vier")
	require.Equal(t, base.Add(time.Minute).UnixMilli(), itens[0].Em)
}

func TestHistoricoTemTeto(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	base := time.Now().Add(-24 * time.Hour)

	// Direto no repositório: o teto por pedido (50) faria deste teste cinco
	// viagens HTTP para provar uma regra que mora no SQL.
	semear := make([]history.Item, 0, history.MaxItens)
	for i := range history.MaxItens {
		semear = append(semear, history.Item{
			TrackID: fmt.Sprintf("f%03d", i), Titulo: "t", Artista: "a", Dur: 1,
			Em: base.Add(time.Duration(i) * time.Second),
		})
	}
	_, err := history.NewHistory(pool).Registrar(context.Background(), eu, semear)
	require.NoError(t, err)

	w := servir(r, comCookie(t, cfg, postHistorico(t,
		itemJSON{TrackID: "a-mais-nova", Titulo: "t", Artista: "a", Dur: 1, Em: time.Now().Add(-time.Minute).UnixMilli()},
	), eu))
	require.Equal(t, http.StatusOK, w.Code)
	itens := itensDe(t, w)
	require.Len(t, itens, history.MaxItens, "o histórico não cresce além do teto")
	require.Equal(t, "a-mais-nova", itens[0].TrackID)
	require.NotContains(t, idsDosItens(itens), "f000", "quem sai é a mais antiga")
	require.Contains(t, idsDosItens(itens), "f001")
}

func TestPedidoDeHistoricoForaDoTetoNaoPassa(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	agora := time.Now().UnixMilli()

	muitos := make([]itemJSON, maxItensPorPedido+1)
	for i := range muitos {
		muitos[i] = itemJSON{TrackID: fmt.Sprintf("id%d", i), Titulo: "t", Em: agora}
	}
	require.Equal(t, http.StatusBadRequest,
		servir(r, comCookie(t, cfg, postHistorico(t, muitos...), eu)).Code, "o lote tem teto")

	for nome, it := range map[string]itemJSON{
		"sem id":           {TrackID: "", Titulo: "t", Em: agora},
		"título gigante":   {TrackID: "a", Titulo: strings.Repeat("ã", maxRunasDoRetrato+1), Em: agora},
		"sem carimbo":      {TrackID: "a", Titulo: "t"},
		"duração negativa": {TrackID: "a", Titulo: "t", Dur: -1, Em: agora},
	} {
		require.Equal(t, http.StatusBadRequest,
			servir(r, comCookie(t, cfg, postHistorico(t, it), eu)).Code, nome)
	}

	// O teto do retrato é em RUNAS: duzentos caracteres acentuados passam, e em
	// bytes não passariam.
	w := servir(r, comCookie(t, cfg, postHistorico(t,
		itemJSON{TrackID: "a", Titulo: strings.Repeat("ã", maxRunasDoRetrato), Em: agora}), eu))
	require.Equal(t, http.StatusOK, w.Code)
}

// "Esquecer o que ouvi" e "perder onde parei" são dois pedidos. Só o primeiro
// foi feito.
func TestLimparOHistoricoNaoApagaOMarcador(t *testing.T) {
	r, pool, cfg := montar(t, true)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	agora := time.Now().Add(-time.Minute)

	require.Equal(t, http.StatusOK, servir(r, comCookie(t, cfg, putMarcador(t, "demo1", 33, agora), eu)).Code)
	require.Equal(t, http.StatusOK, servir(r, comCookie(t, cfg,
		postHistorico(t, itemJSON{TrackID: "demo1", Titulo: "t", Em: agora.UnixMilli()}), eu)).Code)

	w := servir(r, comCookie(t, cfg, httptest.NewRequest(http.MethodDelete, "/api/history", nil), eu))
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), `"itens":[]`)

	w = servir(r, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/history", nil), eu))
	require.Empty(t, itensDe(t, w))
	w = servir(r, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/playback", nil), eu))
	require.Equal(t, "demo1", marcadorDe(t, w).TrackID, "o marcador tinha de continuar lá")
}

// Sem FK, ninguém limpa o histórico e o marcador da faixa que deixou de existir
// — então `removerFaixa` limpa, e para TODAS as contas: faixa compartilhada
// entra no histórico de quem a recebeu, e o retrato dela (título, artista)
// ficaria à mostra depois de o dono a apagar.
func TestApagarFaixaDoAcervoTiraDoHistoricoEDoMarcadorDeTodos(t *testing.T) {
	r, pool, cfg := montar(t, true)
	ctx := context.Background()
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	convidado := dbtest.CriarUsuario(t, pool, "convidado@exemplo.test")

	const id = "11111111-1111-4111-8111-111111111111"
	_, err := acervo.NewTracks(pool).Criar(ctx, acervo.Nova{
		ID: id, UserID: eu, Title: "minha", Artist: "a", Genre: "acervo", DurS: 10,
		AudioKey: "u/eu/a/1.mp3", AudioType: "audio/mpeg", SizeBytes: 1,
	})
	require.NoError(t, err)
	agora := time.Now().Add(-time.Minute)

	for _, quem := range []string{eu, convidado} {
		ouvir(t, r, cfg, quem, prefixoID+id, agora)
	}
	// Uma faixa que NÃO é a apagada, para a limpeza não ser um `DELETE` sem
	// `WHERE` passando despercebido.
	require.Equal(t, http.StatusOK, servir(r, comCookie(t, cfg,
		postHistorico(t, itemJSON{TrackID: "demo1", Titulo: "t", Em: agora.UnixMilli()}), eu)).Code)

	w := servir(r, comCookie(t, cfg, httptest.NewRequest(http.MethodDelete, "/api/acervo/"+id, nil), eu))
	require.Equal(t, http.StatusOK, w.Code)

	contar := func(tabela string) (n int) {
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT count(*) FROM `+tabela+` WHERE track_id = $1`, prefixoID+id).Scan(&n))
		return n
	}
	require.Zero(t, contar("history"), "o histórico de QUALQUER conta tinha de perder a faixa")
	require.Zero(t, contar("playback"), "e o marcador também: ele armaria o player com algo que não toca mais")

	w = servir(r, comCookie(t, cfg, httptest.NewRequest(http.MethodGet, "/api/history", nil), eu))
	require.Equal(t, []string{"demo1"}, idsDosItens(itensDe(t, w)), "as outras faixas ficam")
}

// `ON DELETE CASCADE`: apagar a conta não pode deixar para trás o que ela ouviu.
func TestApagarAContaLevaOMarcadorEOHistorico(t *testing.T) {
	r, pool, cfg := montar(t, true)
	ctx := context.Background()
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	ouvir(t, r, cfg, eu, "demo1", time.Now().Add(-time.Minute))

	_, err := pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, eu)
	require.NoError(t, err)

	for _, tabela := range []string{"history", "playback"} {
		var n int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM `+tabela).Scan(&n))
		require.Zero(t, n, tabela)
	}
}

// ouvir grava o marcador e a linha do histórico de uma faixa, que é o que a PWA
// faz quando alguém ouve uma música até contar.
func ouvir(t *testing.T, r http.Handler, cfg *config.Config, quem, trackID string, quando time.Time) {
	t.Helper()
	require.Equal(t, http.StatusOK, servir(r, comCookie(t, cfg, putMarcador(t, trackID, 5, quando), quem)).Code)
	require.Equal(t, http.StatusOK, servir(r, comCookie(t, cfg,
		postHistorico(t, itemJSON{TrackID: trackID, Titulo: "t", Artista: "a", Dur: 10, Em: quando.UnixMilli()}), quem)).Code)
}
