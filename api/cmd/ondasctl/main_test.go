package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

const tokenDeTeste = "token-de-teste"

const idDaFulana = "11111111-1111-4111-8111-111111111111"

// apiFalsa é o mínimo de `/api/admin` que a CLI enxerga, com memória: aprovar
// muda o que a listagem seguinte devolve. Anota cada pedido para o teste poder
// afirmar o que a CLI mandou, e não só o que ela imprimiu.
type apiFalsa struct {
	contas  []conta
	pedidos []string
	corpos  []string
}

func novaAPI() *apiFalsa {
	quando := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)
	return &apiFalsa{contas: []conta{
		{ID: idDaFulana, Email: "fulana@exemplo.test", Name: "Fulana", Status: "pendente",
			Mensagem: "quero testar", CriadaEm: quando},
		{ID: "22222222-2222-4222-8222-222222222222", Email: "dono@exemplo.test", Name: "dono",
			Status: "aprovada", PodeEnviar: true, CriadaEm: quando.Add(-time.Hour)},
	}}
}

func (a *apiFalsa) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	corpo, _ := io.ReadAll(r.Body)
	a.pedidos = append(a.pedidos, r.Method+" "+r.URL.RequestURI())
	a.corpos = append(a.corpos, string(corpo))

	w.Header().Set("Content-Type", "application/json")
	if r.Header.Get("X-Ondas-Admin-Token") != tokenDeTeste {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"token inválido","code":"token_invalido"}`))
		return
	}
	partes := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/admin/contas"), "/")
	if len(partes) == 1 {
		saida := []conta{}
		for _, c := range a.contas {
			q := r.URL.Query()
			if (q.Get("status") == "" || q.Get("status") == c.Status) &&
				(q.Get("email") == "" || strings.EqualFold(q.Get("email"), c.Email)) {
				saida = append(saida, c)
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"contas": saida})
		return
	}
	for i := range a.contas {
		if a.contas[i].ID != partes[1] {
			continue
		}
		switch partes[2] {
		case "aprovar":
			a.contas[i].Status = "aprovada"
		case "negar":
			a.contas[i].Status = "negada"
		case "envio":
			var req struct{ PodeEnviar bool }
			_ = json.Unmarshal(corpo, &req)
			a.contas[i].PodeEnviar = req.PodeEnviar
		}
		_ = json.NewEncoder(w).Encode(a.contas[i])
		return
	}
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write([]byte(`{"error":"conta não encontrada","code":"conta_nao_encontrada"}`))
}

// rodar executa a CLI contra a API falsa e devolve código, stdout e stderr.
func rodar(t *testing.T, api http.Handler, ambiente map[string]string, args ...string) (int, string, string) {
	t.Helper()
	srv := httptest.NewServer(api)
	t.Cleanup(srv.Close)
	env := map[string]string{"ONDAS_API_URL": srv.URL, "ONDAS_ADMIN_TOKEN": tokenDeTeste}
	for k, v := range ambiente {
		env[k] = v
	}
	var out, errOut bytes.Buffer
	codigo := executar(args, func(k string) string { return env[k] }, &out, &errOut)
	return codigo, out.String(), errOut.String()
}

func TestListarMostraAFilaPorPadrao(t *testing.T) {
	api := novaAPI()
	codigo, out, _ := rodar(t, api, nil, "contas", "listar")
	require.Equal(t, saidaOK, codigo)
	require.Equal(t, []string{"GET /api/admin/contas?status=pendente"}, api.pedidos)
	require.Contains(t, out, "fulana@exemplo.test")
	require.Contains(t, out, "quero testar")
	require.NotContains(t, out, "dono@exemplo.test")
}

func TestListarTodasEmJSON(t *testing.T) {
	api := novaAPI()
	codigo, out, _ := rodar(t, api, nil, "contas", "listar", "--status", "todas", "--json")
	require.Equal(t, saidaOK, codigo)
	require.Equal(t, []string{"GET /api/admin/contas"}, api.pedidos)
	var contas []conta
	require.NoError(t, json.Unmarshal([]byte(out), &contas), out)
	require.Len(t, contas, 2)
}

// Fila vazia em JSON é `[]`: quem lê por script não pode receber `null`.
func TestListarVazioEmJSON(t *testing.T) {
	codigo, out, _ := rodar(t, novaAPI(), nil, "contas", "listar", "--status=negada", "--json")
	require.Equal(t, saidaOK, codigo)
	require.Equal(t, "[]", strings.TrimSpace(out))
}

func TestAprovarPorEmailResolveOID(t *testing.T) {
	api := novaAPI()
	codigo, out, _ := rodar(t, api, nil, "contas", "aprovar", "fulana@exemplo.test")
	require.Equal(t, saidaOK, codigo)
	require.Equal(t, []string{
		"GET /api/admin/contas?email=fulana%40exemplo.test",
		"POST /api/admin/contas/" + idDaFulana + "/aprovar",
	}, api.pedidos)
	require.Contains(t, out, "status=aprovada")
}

func TestNegarPorIDVaiDiretoEAceitaJSONDepoisDoAlvo(t *testing.T) {
	api := novaAPI()
	codigo, out, _ := rodar(t, api, nil, "contas", "negar", idDaFulana, "--json")
	require.Equal(t, saidaOK, codigo)
	require.Equal(t, []string{"POST /api/admin/contas/" + idDaFulana + "/negar"}, api.pedidos)
	var feita conta
	require.NoError(t, json.Unmarshal([]byte(out), &feita), out)
	require.Equal(t, "negada", feita.Status)
}

func TestEnvioLigaEDesliga(t *testing.T) {
	api := novaAPI()
	codigo, out, _ := rodar(t, api, nil, "contas", "envio", idDaFulana, "on")
	require.Equal(t, saidaOK, codigo)
	require.Equal(t, `{"podeEnviar":true}`, api.corpos[0])
	require.Contains(t, out, "envio=sim")

	codigo, out, _ = rodar(t, api, nil, "contas", "envio", idDaFulana, "off")
	require.Equal(t, saidaOK, codigo)
	require.Equal(t, `{"podeEnviar":false}`, api.corpos[1])
	require.Contains(t, out, "envio=não")
}

func TestErrosDeUsoSaemComDoisESemChamarAAPI(t *testing.T) {
	casos := [][]string{
		{"contas"},
		{"faixas", "listar"},
		{"contas", "apagar", idDaFulana},
		{"contas", "aprovar"},
		{"contas", "aprovar", "nem-id-nem-email"},
		{"contas", "envio", idDaFulana},
		{"contas", "envio", idDaFulana, "talvez"},
		{"contas", "listar", "--status", "qualquer"},
		{"contas", "listar", "--status"},
		{"contas", "listar", "sobrando"},
		{"contas", "aprovar", idDaFulana, "--status", "pendente"},
		{"contas", "listar", "--formato=yaml"},
	}
	for _, args := range casos {
		api := novaAPI()
		codigo, out, errOut := rodar(t, api, nil, args...)
		require.Equal(t, saidaUso, codigo, "%v: %s", args, errOut)
		require.Empty(t, api.pedidos, "%v não pode ter chegado à API", args)
		require.Empty(t, out, "%v: erro vai para o stderr", args)
		require.NotEmpty(t, errOut)
	}
}

func TestSemTokenNaoChamaAAPI(t *testing.T) {
	api := novaAPI()
	codigo, _, errOut := rodar(t, api, map[string]string{"ONDAS_ADMIN_TOKEN": ""}, "contas", "listar")
	require.Equal(t, saidaUso, codigo)
	require.Empty(t, api.pedidos)
	require.Contains(t, errOut, "ONDAS_ADMIN_TOKEN")
}

func TestTokenVemDeArquivo(t *testing.T) {
	arquivo := filepath.Join(t.TempDir(), "token")
	require.NoError(t, os.WriteFile(arquivo, []byte(tokenDeTeste+"\n"), 0o600))

	codigo, _, errOut := rodar(t, novaAPI(),
		map[string]string{"ONDAS_ADMIN_TOKEN": "", "ONDAS_ADMIN_TOKEN_FILE": arquivo}, "contas", "listar")
	require.Equal(t, saidaOK, codigo, errOut)
}

// O token vai num cabeçalho: em http, para fora da máquina, ele iria em claro.
func TestRecusaMandarOTokenEmHTTPParaFora(t *testing.T) {
	api := novaAPI()
	codigo, _, errOut := rodar(t, api, map[string]string{"ONDAS_API_URL": "http://ondas.exemplo.test"},
		"contas", "listar")
	require.Equal(t, saidaUso, codigo)
	require.Contains(t, errOut, "https")
}

func TestTokenRecusadoSaiComUm(t *testing.T) {
	codigo, _, errOut := rodar(t, novaAPI(), map[string]string{"ONDAS_ADMIN_TOKEN": "errado"}, "contas", "listar")
	require.Equal(t, saidaErro, codigo)
	require.Contains(t, errOut, "401")
	require.NotContains(t, errOut, "errado", "o token nunca aparece na saída")
}

func TestContaInexistenteSaiComUm(t *testing.T) {
	codigo, _, errOut := rodar(t, novaAPI(), nil, "contas", "aprovar", "ninguem@exemplo.test")
	require.Equal(t, saidaErro, codigo)
	require.Contains(t, errOut, "ninguem@exemplo.test")

	codigo, _, errOut = rodar(t, novaAPI(), nil, "contas", "aprovar", "33333333-3333-4333-8333-333333333333")
	require.Equal(t, saidaErro, codigo)
	require.Contains(t, errOut, "conta não encontrada")
}

// A API sem `ADMIN_TOKEN_SHA256` responde o 404 seco do roteador; a CLI tem de
// dizer o que isso quer dizer, em vez de "erro 404".
func TestAdministracaoDesligadaTemMensagemPropria(t *testing.T) {
	codigo, _, errOut := rodar(t, http.NotFoundHandler(), nil, "contas", "listar")
	require.Equal(t, saidaErro, codigo)
	require.Contains(t, errOut, "ADMIN_TOKEN_SHA256")
}

// Um 302 não pode levar o token de admin para outro host.
func TestNaoSegueRedirectComOToken(t *testing.T) {
	recebeuToken := false
	outro := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		recebeuToken = recebeuToken || r.Header.Get("X-Ondas-Admin-Token") != ""
	}))
	defer outro.Close()

	codigo, _, _ := rodar(t, http.RedirectHandler(outro.URL, http.StatusFound), nil, "contas", "listar")
	require.Equal(t, saidaErro, codigo)
	require.False(t, recebeuToken)
}

// A mensagem do pedido é texto de um desconhecido: sequência de escape não pode
// chegar crua ao terminal do admin.
func TestTabelaNaoImprimeCaractereDeControle(t *testing.T) {
	api := novaAPI()
	api.contas[0].Mensagem = "oi\x1b[2J\x1b[H\nsegunda linha\tcom tab"
	codigo, out, _ := rodar(t, api, nil, "contas", "listar")
	require.Equal(t, saidaOK, codigo)
	require.NotContains(t, out, "\x1b")
	require.Len(t, strings.Split(strings.TrimSpace(out), "\n"), 2, "cabeçalho e uma linha só: %q", out)
}

func TestAjuda(t *testing.T) {
	for _, args := range [][]string{{}, {"ajuda"}, {"--help"}} {
		codigo, out, _ := rodar(t, novaAPI(), nil, args...)
		require.Equal(t, saidaOK, codigo)
		require.Contains(t, out, "ondasctl contas listar")
	}
}
