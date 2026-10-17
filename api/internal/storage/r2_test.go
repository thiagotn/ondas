package storage

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Um S3 de mentira: não precisa de R2 de verdade para provar que o cliente
// manda o objeto no caminho certo, com o content-type certo.
type s3Falso struct {
	metodo      string
	caminho     string
	contentType string
	cacheCtl    string
	corpo       string
	status      int
}

func (f *s3Falso) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		f.metodo = r.Method
		f.caminho = r.URL.Path
		f.contentType = r.Header.Get("Content-Type")
		f.cacheCtl = r.Header.Get("Cache-Control")
		b, _ := io.ReadAll(r.Body)
		f.corpo = string(b)
		if f.status != 0 {
			w.WriteHeader(f.status)
			return
		}
		w.Header().Set("ETag", `"abc"`)
		w.WriteHeader(http.StatusOK)
	}
}

func novoR2Falso(t *testing.T, f *s3Falso) (*R2, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(f.handler())
	u, err := url.Parse(srv.URL)
	require.NoError(t, err)
	r2, err := NewComEndpoint(u.Host, false, "chave", "segredo", "ondas-acervo", time.Hour)
	require.NoError(t, err)
	return r2, srv
}

func TestEnviarGravaNoCaminhoDoBucket(t *testing.T) {
	f := &s3Falso{}
	r2, srv := novoR2Falso(t, f)
	defer srv.Close()

	dados := "bytes-de-audio"
	err := r2.Enviar(context.Background(), "u/abc/a/def.mp3", "audio/mpeg",
		strings.NewReader(dados), int64(len(dados)))
	require.NoError(t, err)

	require.Equal(t, http.MethodPut, f.metodo)
	require.Equal(t, "/ondas-acervo/u/abc/a/def.mp3", f.caminho)
	require.Equal(t, "audio/mpeg", f.contentType)
	// Objeto privado não deve ser guardado por intermediário nenhum.
	require.Contains(t, f.cacheCtl, "no-store")
	// Em HTTP sem TLS o minio-go assina o corpo em chunks (aws-chunked), então
	// o payload vem envelopado — o que importa é que os bytes estão lá.
	require.Contains(t, f.corpo, dados)
}

func TestEnviarPropagaErroDoServidor(t *testing.T) {
	f := &s3Falso{status: http.StatusForbidden}
	r2, srv := novoR2Falso(t, f)
	defer srv.Close()

	err := r2.Enviar(context.Background(), "k", "audio/mpeg", strings.NewReader("x"), 1)
	require.Error(t, err)
	require.Contains(t, err.Error(), "enviar k")
}

// A URL assinada é o que vai no Location do 302: tem de apontar para o objeto,
// levar assinatura e ter prazo.
func TestURLAssinadaTemChaveAssinaturaEPrazo(t *testing.T) {
	f := &s3Falso{}
	r2, srv := novoR2Falso(t, f)
	defer srv.Close()

	bruta, err := r2.URLAssinada(context.Background(), "u/abc/a/def.mp3")
	require.NoError(t, err)

	u, err := url.Parse(bruta)
	require.NoError(t, err)
	require.Equal(t, "/ondas-acervo/u/abc/a/def.mp3", u.Path)
	q := u.Query()
	require.NotEmpty(t, q.Get("X-Amz-Signature"))
	require.Equal(t, "3600", q.Get("X-Amz-Expires"))
	require.Contains(t, q.Get("X-Amz-Credential"), "chave")
	// O segredo NUNCA pode aparecer na URL.
	require.NotContains(t, bruta, "segredo")
}

func TestTTLDiferenteMudaOPrazoDaAssinatura(t *testing.T) {
	f := &s3Falso{}
	srv := httptest.NewServer(f.handler())
	defer srv.Close()
	u, _ := url.Parse(srv.URL)

	r2, err := NewComEndpoint(u.Host, false, "chave", "segredo", "ondas-acervo", 15*time.Minute)
	require.NoError(t, err)
	bruta, err := r2.URLAssinada(context.Background(), "k")
	require.NoError(t, err)
	assinada, err := url.Parse(bruta)
	require.NoError(t, err)
	require.Equal(t, "900", assinada.Query().Get("X-Amz-Expires"))
}

func TestRemoverEhNoOpComChaveVazia(t *testing.T) {
	f := &s3Falso{}
	r2, srv := novoR2Falso(t, f)
	defer srv.Close()

	// Faixa sem capa tem key vazia: remover não pode virar um DELETE no
	// caminho raiz do bucket.
	require.NoError(t, r2.Remover(context.Background(), ""))
	require.Empty(t, f.metodo, "não deveria ter saído requisição nenhuma")
}

func TestConfiguracaoIncompletaFalhaNaConstrucao(t *testing.T) {
	_, err := New("", "k", "s", "b", time.Hour)
	require.Error(t, err)

	_, err = NewComEndpoint("host", true, "", "s", "b", time.Hour)
	require.Error(t, err)

	_, err = NewComEndpoint("host", true, "k", "s", "", time.Hour)
	require.Error(t, err)

	// TTL zero geraria URL que já nasce vencida.
	_, err = NewComEndpoint("host", true, "k", "s", "bkt", 0)
	require.Error(t, err)
}
