package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/thiagotn/ondas/api/internal/audius"
	"github.com/thiagotn/ondas/api/internal/config"
)

// audiusFalso serve um Audius de mentira e conta quantas vezes foi procurado.
// A contagem é o que prova as duas coisas que importam: o cache funciona, e o
// caminho da faixa privada não sai da nossa casa.
func audiusFalso(t *testing.T, faixa map[string]any) (*audius.Client, *int32) {
	t.Helper()
	var hits int32
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		if r.URL.Path == "/" {
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []string{srv.URL}})
			return
		}
		atomic.AddInt32(&hits, 1)
		if faixa == nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": faixa})
	}))
	t.Cleanup(srv.Close)
	return audius.New(audius.Opcoes{Discovery: srv.URL, HTTP: srv.Client()}), &hits
}

// servidorOG monta o roteador SEM banco — `pool` nil.
//
// Não é economia de setup: é a prova de que o caminho da faixa privada não
// consulta nada. Qualquer query entraria em pânico aqui.
func servidorOG(t *testing.T, cliente *audius.Client) http.Handler {
	t.Helper()
	srv := New(&config.Config{OrigemPWA: "https://music.exemplo.test"}, nil)
	if cliente != nil {
		srv.audius = cliente
	}
	return srv.Router()
}

func pedirOG(t *testing.T, h http.Handler, seg string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/og/t/"+seg, nil))
	return w
}

func TestOGDeFaixaPublica(t *testing.T) {
	cliente, hits := audiusFalso(t, map[string]any{
		"id": "J72oWO6", "title": "Long Drive", "genre": "Electronic", "duration": 150,
		"user":    map[string]any{"name": "Tohaj"},
		"artwork": map[string]any{"1000x1000": "https://cdn.exemplo/capa.jpg"},
	})
	w := pedirOG(t, servidorOG(t, cliente), "tohaj-long-drive-J72oWO6")

	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Header().Get("Content-Type"), "text/html")
	corpo := w.Body.String()
	require.Contains(t, corpo, `property="og:title" content="Long Drive"`)
	require.Contains(t, corpo, `content="Tohaj · #Electronic · 2:30"`)
	require.Contains(t, corpo, `content="https://cdn.exemplo/capa.jpg"`)
	// O canônico é o link bonito, não a URL interna de onde o robô caiu.
	require.Contains(t, corpo, `content="https://music.exemplo.test/t/tohaj-long-drive-J72oWO6"`)
	require.Equal(t, int32(1), *hits)
}

func TestOGNaoDeixaTituloVirarMarcacao(t *testing.T) {
	cliente, _ := audiusFalso(t, map[string]any{
		"id": "abc123", "title": `<script>alert(1)</script>"onload="x`,
		"user": map[string]any{"name": "a"},
	})
	corpo := pedirOG(t, servidorOG(t, cliente), "x-abc123").Body.String()

	// Título e artista vêm de terceiro e caem dentro de atributo: é por isso
	// que o corpo sai de `html/template`, nunca de concatenação.
	require.NotContains(t, corpo, "<script>alert(1)</script>")
	require.NotContains(t, corpo, `"onload="x`)
}

func TestOGDeFaixaPrivadaNaoDizNada(t *testing.T) {
	cliente, hits := audiusFalso(t, nil)
	h := servidorOG(t, cliente)

	// Dois uuids diferentes — um que poderia existir e outro que não — têm de
	// devolver exatamente a mesma coisa. Resposta diferenciada já contaria a
	// um estranho que aquele uuid está no acervo.
	segA, segB := "_11111111111141118111111111111111", "_ffffffffffff4fff8fffffffffffffff"
	a := pedirOG(t, h, segA)
	b := pedirOG(t, h, segB)

	require.Equal(t, http.StatusOK, a.Code)
	// Tirando o token que o próprio chamador mandou (e que ele já conhece),
	// as duas respostas têm de ser byte a byte iguais.
	require.Equal(t,
		strings.ReplaceAll(a.Body.String(), segA, "<seg>"),
		strings.ReplaceAll(b.Body.String(), segB, "<seg>"),
	)
	require.Contains(t, a.Body.String(), "faixa privada")
	require.Equal(t, "noindex", a.Header().Get("X-Robots-Tag"))
	// Nem o banco (o servidor foi montado com pool nil) nem o Audius.
	require.Equal(t, int32(0), *hits)
}

func TestOGComTokenInvalidoNaoProcuraNada(t *testing.T) {
	cliente, hits := audiusFalso(t, nil)
	h := servidorOG(t, cliente)

	for _, seg := range []string{"foo-", "fi", "foo-J72$oWO6", "_naohex", "_ABC",
		strings.Repeat("x", 200)} {
		w := pedirOG(t, h, seg)
		// 200 e não 4xx: desembrulhador que recebe erro desiste da prévia, e
		// o usuário veria link cru em vez de cartão.
		require.Equal(t, http.StatusOK, w.Code, "segmento %q", seg)
		require.Contains(t, w.Body.String(), "inválido", "segmento %q", seg)
	}
	require.Equal(t, int32(0), *hits)
}

func TestOGGuardaAFaixaEmCache(t *testing.T) {
	cliente, hits := audiusFalso(t, map[string]any{
		"id": "abc123", "title": "t", "user": map[string]any{"name": "a"},
	})
	h := servidorOG(t, cliente)
	for range 3 {
		require.Equal(t, http.StatusOK, pedirOG(t, h, "x-abc123").Code)
	}
	// Um link circulando num grupo é um desembrulho por membro; sem cache
	// isso vira uma rajada no Audius por um dado que não muda.
	require.Equal(t, int32(1), *hits)
}

func TestOGDeFaixaSumidaAindaDaCartao(t *testing.T) {
	cliente, _ := audiusFalso(t, nil)
	w := pedirOG(t, servidorOG(t, cliente), "x-sumiu1")
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), "não encontrada")
}

func TestOGEhPublicaECacheavel(t *testing.T) {
	cliente, _ := audiusFalso(t, map[string]any{
		"id": "abc123", "title": "t", "user": map[string]any{"name": "a"},
	})
	w := pedirOG(t, servidorOG(t, cliente), "x-abc123")

	// Sem cookie nenhum no pedido: a rota não pode estar atrás de sessão.
	require.NotEqual(t, http.StatusUnauthorized, w.Code)
	require.Empty(t, w.Header().Values("Set-Cookie"))
	// É o único endpoint da API deliberadamente cacheável — o resto responde
	// `no-store` por `escreverJSON`.
	require.Contains(t, w.Header().Get("Cache-Control"), "public")
}

// A tabela abaixo é a MESMA de `packages/core/src/__tests__/share.test.ts`,
// copiada à mão de propósito. Nada aqui pode ler arquivo do monorepo: a
// imagem desta API é construída com o contexto `api/` apenas, e um teste que
// saísse dessa pasta quebraria a build mesmo passando no `verify` — já
// aconteceu. Se mexer num lado, mexa no outro.
func TestIdDoTokenEspelhaOCore(t *testing.T) {
	casos := []struct {
		seg     string
		publico string
		privado bool
		ok      bool
	}{
		{"turbo-vicio-concreto-molhado-J72oWO6", "J72oWO6", false, true},
		{"lo-fi-parte-2-abc123", "abc123", false, true},
		{"J72oWO6", "J72oWO6", false, true},
		{"_11111111111141118111111111111111", "", true, true},
		{"_AAAAAAAABBBB4CCC8DDDEEEEEEEEEEEE", "", true, true},
		{"", "", false, false},
		{"-", "", false, false},
		{"foo-", "", false, false},
		{"fi", "", false, false},
		{"foo-J72$oWO6", "", false, false},
		{"_naohex", "", true, false},
		{"_ABC", "", true, false},
		{strings.Repeat("x", 200), "", false, false},
	}
	for _, c := range casos {
		publico, privado, ok := idDoToken(c.seg)
		require.Equal(t, c.ok, ok, "segmento %q", c.seg)
		require.Equal(t, c.privado, privado, "segmento %q", c.seg)
		require.Equal(t, c.publico, publico, "segmento %q", c.seg)
	}
}
