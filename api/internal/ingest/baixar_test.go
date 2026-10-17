package ingest

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// O httptest escuta em 127.0.0.1, que a política de produção recusa — com
// razão. Para exercitar o caminho feliz o loopback é liberado, e SÓ ele: todo
// o resto (privadas, link-local, CGNAT) continua vetado, inclusive nos saltos
// de redirect.
func soLoopback(ip net.IP) bool {
	return ip.IsLoopback() || enderecoPermitido(ip)
}

// O worker roda dentro do cluster e a URL vem de fora: esta tabela é a trava
// que separa "ingira esta música" de "faça uma requisição na minha rede
// interna".
func TestEnderecosInternosSaoRecusados(t *testing.T) {
	proibidos := []struct{ nome, url string }{
		{"loopback", "http://127.0.0.1:8080/x.mp3"},
		{"loopback v6", "http://[::1]:8080/x.mp3"},
		{"metadata da nuvem", "http://169.254.169.254/latest/meta-data/"},
		{"service do k3s", "http://10.43.0.1/x.mp3"},
		{"pod do k3s", "http://10.42.1.7:8080/x.mp3"},
		{"postgres por IP privado", "http://192.168.0.5:5432/x"},
		{"malha headscale (CGNAT)", "http://100.64.0.1/x.mp3"},
		{"privada 172.16", "http://172.20.3.4/x.mp3"},
		{"endereço zero", "http://0.0.0.0/x.mp3"},
		{"unique local v6", "http://[fc00::1]/x.mp3"},
		{"link-local v6", "http://[fe80::1]/x.mp3"},
		{"NAT64 para privado", "http://[64:ff9b::a2b:304]/x.mp3"},
	}
	for _, c := range proibidos {
		t.Run(c.nome, func(t *testing.T) {
			b := NewBaixador(1<<20, 2*time.Second)
			_, _, err := b.Baixar(context.Background(), c.url, io.Discard)
			require.Error(t, err)
			require.ErrorIs(t, err, ErrDestinoVetado, "deveria ser vetado: %s", c.url)
		})
	}
}

// `127.1` é atalho de 127.0.0.1 para o resolver do sistema, mas não é IP
// literal para o Go. Nos dois mundos o pedido morre: com o resolver puro do Go
// a busca falha, e com cgo o endereço resolvido chega ao dialer e cai na trava.
// O teste só exige que NÃO complete — não qual dos dois caminhos barrou.
func TestAtalhoDeLoopbackNaoCompleta(t *testing.T) {
	b := NewBaixador(1<<20, 2*time.Second)
	_, _, err := b.Baixar(context.Background(), "http://127.1/x.mp3", io.Discard)
	require.Error(t, err)
}

func TestEsquemasEstranhosSaoRecusados(t *testing.T) {
	for _, u := range []string{
		"file:///etc/passwd",
		"gopher://127.0.0.1:70/x",
		"ftp://exemplo.com/a.mp3",
		"http://usuario:senha@exemplo.com/a.mp3",
		"nao-e-url",
	} {
		b := NewBaixador(1<<20, 2*time.Second)
		_, _, err := b.Baixar(context.Background(), u, io.Discard)
		require.ErrorIs(t, err, ErrURLInvalida, "deveria recusar %q", u)
	}
}

// Um nome de domínio público que resolve para IP privado é o caso que uma
// validação só da URL deixaria passar — e é o que o Control pega.
func TestNomePublicoQueResolveParaPrivadoNaoConecta(t *testing.T) {
	b := NewBaixador(1<<20, 3*time.Second)
	// localtest.me resolve para 127.0.0.1 na internet pública.
	_, _, err := b.Baixar(context.Background(), "http://localtest.me/musica.mp3", io.Discard)
	require.Error(t, err)
	require.ErrorIs(t, err, ErrDestinoVetado,
		"o veto tem de acontecer na hora de conectar, não só na validação do nome")
}

func TestRedirectParaEnderecoInternoNaoEhSeguido(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data/", http.StatusFound)
	}))
	defer srv.Close()

	// Só o loopback é liberado: o salto para 169.254.169.254 continua tendo de
	// ser recusado, e é isso que está sob teste.
	b := newBaixador(1<<20, 3*time.Second, soLoopback)
	_, _, err := b.Baixar(context.Background(), srv.URL+"/a.mp3", io.Discard)
	require.ErrorIs(t, err, ErrDestinoVetado)
}

func TestCadeiaDeRedirectsLongaDemais(t *testing.T) {
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, srv.URL+r.URL.Path+"x", http.StatusFound)
	}))
	defer srv.Close()

	b := newBaixador(1<<20, 5*time.Second, soLoopback)
	_, _, err := b.Baixar(context.Background(), srv.URL+"/a", io.Discard)
	require.ErrorIs(t, err, ErrURLInvalida)
}

func TestBaixaOCorpoEDevolveTipoETamanho(t *testing.T) {
	conteudo := bytes.Repeat([]byte("ondas"), 1000)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "audio/mpeg")
		_, _ = w.Write(conteudo)
	}))
	defer srv.Close()

	var buf bytes.Buffer
	b := newBaixador(1<<20, 5*time.Second, soLoopback)
	tipo, n, err := b.Baixar(context.Background(), srv.URL+"/a.mp3", &buf)
	require.NoError(t, err)
	require.Equal(t, "audio/mpeg", tipo)
	require.Equal(t, int64(len(conteudo)), n)
	require.Equal(t, conteudo, buf.Bytes())
}

// O teto é sobre os bytes que chegam, não sobre o que a origem declara: aqui
// não há Content-Length nenhum (resposta chunked), que é justamente o caso em
// que confiar no cabeçalho não salvaria.
func TestTetoDeTamanhoVigoraSemContentLength(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "audio/mpeg")
		for i := 0; i < 50; i++ {
			_, _ = w.Write(bytes.Repeat([]byte("x"), 1024))
			w.(http.Flusher).Flush()
		}
	}))
	defer srv.Close()

	b := newBaixador(8<<10, 5*time.Second, soLoopback)
	_, _, err := b.Baixar(context.Background(), srv.URL+"/a.mp3", io.Discard)
	require.ErrorIs(t, err, ErrGrandeDemais)
}

func TestCorpoVazioEhErro(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	b := newBaixador(1<<20, 5*time.Second, soLoopback)
	_, _, err := b.Baixar(context.Background(), srv.URL, io.Discard)
	require.Error(t, err)
	require.Contains(t, err.Error(), "vazio")
}

func TestStatusDeErroNaOrigem(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	b := newBaixador(1<<20, 5*time.Second, soLoopback)
	_, _, err := b.Baixar(context.Background(), srv.URL+"/sumiu.mp3", io.Discard)
	require.Error(t, err)
	require.Contains(t, err.Error(), fmt.Sprint(http.StatusNotFound))
}

// Endereços públicos de verdade continuam liberados — a trava não pode ser um
// "nega tudo" disfarçado.
func TestEnderecosPublicosPassamPelaTrava(t *testing.T) {
	for _, ip := range []string{"8.8.8.8", "1.1.1.1", "201.83.245.5", "2606:4700::1111"} {
		u := "http://" + ip + "/a.mp3"
		if strings.Contains(ip, ":") {
			u = "http://[" + ip + "]/a.mp3"
		}
		b := NewBaixador(1<<10, 300*time.Millisecond)
		_, _, err := b.Baixar(context.Background(), u, io.Discard)
		// Vai falhar por timeout/conexão, não por veto: o que importa é que
		// NÃO seja ErrDestinoVetado.
		if err != nil {
			require.NotErrorIs(t, err, ErrDestinoVetado, "IP público %s não devia ser vetado", ip)
		}
	}
}
