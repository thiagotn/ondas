// Package ingest baixa e examina a mídia de uma URL vinda de fora.
package ingest

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"syscall"
	"time"
)

// Endereços que o worker se recusa a alcançar. Ele roda DENTRO do cluster:
// sem esta lista, "ingira esta URL" seria um proxy para os ClusterIPs
// (10.43/16), para o Postgres, para a malha Headscale (100.64/10) e para o
// servidor de metadados da nuvem. É SSRF clássico, e quem manda a URL é o bot.
var redesProibidas = []string{
	"0.0.0.0/8",      // "este host"
	"10.0.0.0/8",     // privada — onde vivem pods e services do k3s
	"100.64.0.0/10",  // CGNAT: a malha Headscale do homelab mora aqui
	"127.0.0.0/8",    // loopback
	"169.254.0.0/16", // link-local, inclui o metadata 169.254.169.254
	"172.16.0.0/12",  // privada
	"192.0.0.0/24",   // reservada IETF
	"192.168.0.0/16", // privada — a LAN de casa
	"198.18.0.0/15",  // benchmark
	"224.0.0.0/4",    // multicast
	"240.0.0.0/4",    // reservada
	"::1/128",        // loopback v6
	"fc00::/7",       // unique local v6
	"fe80::/10",      // link-local v6
	"ff00::/8",       // multicast v6
	"64:ff9b::/96",   // NAT64 — rota para IPv4 privado por via indireta
	"2002::/16",      // 6to4
	"2001::/32",      // Teredo
}

var blocos = func() []*net.IPNet {
	saida := make([]*net.IPNet, 0, len(redesProibidas))
	for _, cidr := range redesProibidas {
		_, rede, err := net.ParseCIDR(cidr)
		if err != nil {
			panic("ingest: CIDR inválido na lista: " + cidr)
		}
		saida = append(saida, rede)
	}
	return saida
}()

var (
	ErrURLInvalida   = errors.New("url inválida")
	ErrDestinoVetado = errors.New("endereço de destino não é público")
	ErrGrandeDemais  = errors.New("arquivo maior que o limite")
)

func enderecoPermitido(ip net.IP) bool {
	if ip == nil {
		return false
	}
	for _, rede := range blocos {
		if rede.Contains(ip) {
			return false
		}
	}
	return true
}

// controlar roda DEPOIS do DNS e ANTES do connect, com o IP já escolhido.
//
// É aqui que a checagem tem de ficar, não só na validação do nome: um host que
// responde IP público na primeira consulta e privado na segunda (DNS rebinding)
// passaria por qualquer validação feita antes. Vale para todo salto de
// redirect, porque cada salto abre sua própria conexão.
func (b *Baixador) controlar(_, endereco string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(endereco)
	if err != nil {
		return fmt.Errorf("%w: %s", ErrDestinoVetado, endereco)
	}
	ip := net.ParseIP(host)
	if ip == nil || !b.permitido(ip) {
		return fmt.Errorf("%w: %s", ErrDestinoVetado, host)
	}
	return nil
}

func (b *Baixador) validarURL(u *url.URL) error {
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("%w: esquema %q não é http(s)", ErrURLInvalida, u.Scheme)
	}
	if u.User != nil {
		return fmt.Errorf("%w: url com usuário/senha embutidos", ErrURLInvalida)
	}
	if u.Hostname() == "" {
		return fmt.Errorf("%w: sem host", ErrURLInvalida)
	}
	// Host escrito como IP dá para recusar já aqui, sem abrir conexão; nome de
	// domínio só se resolve no dialer, e é lá que a mesma política é aplicada.
	if ip := net.ParseIP(u.Hostname()); ip != nil && !b.permitido(ip) {
		return fmt.Errorf("%w: %s", ErrDestinoVetado, u.Hostname())
	}
	return nil
}

type Baixador struct {
	cliente  *http.Client
	maxBytes int64
	// Política de endereço, num lugar só: o dialer e a validação da URL usam
	// esta mesma função. Duas cópias da regra divergem com o tempo.
	permitido func(net.IP) bool
}

func NewBaixador(maxBytes int64, prazo time.Duration) *Baixador {
	return newBaixador(maxBytes, prazo, enderecoPermitido)
}

// newBaixador deixa o teste afrouxar a política (liberar o loopback do
// httptest) sem desligar a trava: o dialer continua conferindo cada conexão,
// inclusive a de cada redirect. Não é exportado de propósito — nada fora deste
// pacote escolhe a política de produção.
func newBaixador(maxBytes int64, prazo time.Duration, permitido func(net.IP) bool) *Baixador {
	b := &Baixador{maxBytes: maxBytes, permitido: permitido}
	b.cliente = &http.Client{
		Timeout: prazo,
		Transport: &http.Transport{
			DialContext: (&net.Dialer{
				Timeout: 10 * time.Second,
				Control: b.controlar,
			}).DialContext,
			TLSHandshakeTimeout: 10 * time.Second,
			DisableKeepAlives:   true,
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("%w: redirects demais", ErrURLInvalida)
			}
			// O primeiro endereço ser público não diz nada sobre onde o
			// Location aponta.
			return b.validarURL(req.URL)
		},
	}
	return b
}

// Baixar escreve o corpo em `destino` e devolve o content-type declarado e o
// tamanho. O content-type serve só de pista: quem decide o que o arquivo é de
// verdade é o ffprobe.
func (b *Baixador) Baixar(ctx context.Context, bruta string, destino io.Writer) (string, int64, error) {
	u, err := url.Parse(bruta)
	if err != nil {
		return "", 0, fmt.Errorf("%w: %v", ErrURLInvalida, err)
	}
	if err := b.validarURL(u); err != nil {
		return "", 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("User-Agent", "ondas-ingest/1.0")
	resp, err := b.cliente.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", 0, fmt.Errorf("origem respondeu %d", resp.StatusCode)
	}
	// Um byte além do limite: se vier, o arquivo é grande demais. Confiar no
	// Content-Length não serve — ele pode mentir ou faltar.
	n, err := io.Copy(destino, io.LimitReader(resp.Body, b.maxBytes+1))
	if err != nil {
		return "", 0, err
	}
	if n > b.maxBytes {
		return "", 0, fmt.Errorf("%w de %d bytes", ErrGrandeDemais, b.maxBytes)
	}
	if n == 0 {
		return "", 0, errors.New("origem devolveu corpo vazio")
	}
	return resp.Header.Get("Content-Type"), n, nil
}
