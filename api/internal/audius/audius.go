// Package audius lê metadados públicos de faixa do Audius, do lado do
// servidor.
//
// Existe por um motivo só: montar a prévia de link (Open Graph). A PWA fala
// com o Audius direto pelo navegador; aqui quem precisa dos dados é o robô do
// WhatsApp, que não executa JavaScript.
package audius

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// ErrNaoEncontrada: o id não existe ou a faixa não é tocável.
var ErrNaoEncontrada = errors.New("faixa não encontrada no audius")

const (
	discoveryPadrao = "https://api.audius.co"
	appName         = "ONDAS"
	// Quanto um host de discovery serve antes de sortear outro. Nós saem da
	// rede; redescobrir de vez em quando é mais barato que descobrir sempre.
	ttlHost = 10 * time.Minute
	// Quanto uma faixa fica guardada. Quando um link circula num grupo, cada
	// membro desembrulha — sem cache isso vira uma rajada no Audius por um
	// dado que não muda.
	TTLFaixa = 6 * time.Hour
	// Teto do cache. Prévia de link é cauda longa; sem teto a memória do pod
	// cresceria com o tempo sem nada que a force a cair.
	maxCache = 512
)

type Faixa struct {
	ID        string
	Titulo    string
	Artista   string
	Genero    string
	Duracao   int
	Capa      string
	Permalink string
}

type resposta struct {
	Data *struct {
		ID           string                `json:"id"`
		Title        string                `json:"title"`
		Genre        string                `json:"genre"`
		Duration     int                   `json:"duration"`
		IsStreamable *bool                 `json:"is_streamable"`
		IsAvailable  *bool                 `json:"is_available"`
		Permalink    string                `json:"permalink"`
		User         struct{ Name string } `json:"user"`
		Artwork      map[string]string     `json:"artwork"`
	} `json:"data"`
}

type entrada struct {
	faixa  Faixa
	expira time.Time
}

type Client struct {
	http      *http.Client
	discovery string
	ttl       time.Duration
	agora     func() time.Time

	mu      sync.Mutex
	host    string
	hostAte time.Time
	cache   map[string]entrada
}

type Opcoes struct {
	HTTP      *http.Client
	Discovery string
	TTL       time.Duration
	Agora     func() time.Time
}

func New(o Opcoes) *Client {
	c := &Client{
		http:      o.HTTP,
		discovery: o.Discovery,
		ttl:       o.TTL,
		agora:     o.Agora,
		cache:     map[string]entrada{},
	}
	if c.http == nil {
		// Curto de propósito: quem espera do outro lado é um robô de prévia,
		// que desiste em poucos segundos. Melhor devolver o cartão genérico
		// do que segurar a conexão.
		c.http = &http.Client{Timeout: 4 * time.Second}
	}
	if c.discovery == "" {
		c.discovery = discoveryPadrao
	}
	if c.ttl == 0 {
		c.ttl = TTLFaixa
	}
	if c.agora == nil {
		c.agora = time.Now
	}
	return c
}

// Faixa devolve os metadados públicos de uma faixa, do cache quando possível.
func (c *Client) Faixa(ctx context.Context, id string) (*Faixa, error) {
	if f, ok := c.doCache(id); ok {
		return &f, nil
	}

	host, err := c.resolverHost(ctx)
	if err != nil {
		return nil, err
	}
	alvo := host + "/v1/tracks/" + url.PathEscape(id) + "?app_name=" + appName
	var r resposta
	if err := c.pegarJSON(ctx, alvo, &r); err != nil {
		return nil, err
	}
	d := r.Data
	if d == nil || d.ID == "" {
		return nil, ErrNaoEncontrada
	}
	// Mesma régua da PWA: faixa que não toca não vira prévia.
	if (d.IsStreamable != nil && !*d.IsStreamable) || (d.IsAvailable != nil && !*d.IsAvailable) {
		return nil, ErrNaoEncontrada
	}

	f := Faixa{
		ID:        d.ID,
		Titulo:    d.Title,
		Artista:   d.User.Name,
		Genero:    d.Genre,
		Duracao:   d.Duration,
		Capa:      primeira(d.Artwork, "1000x1000", "480x480", "150x150"),
		Permalink: d.Permalink,
	}
	c.guardar(id, f)
	return &f, nil
}

func (c *Client) doCache(id string) (Faixa, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.cache[id]
	if !ok || c.agora().After(e.expira) {
		return Faixa{}, false
	}
	return e.faixa, true
}

func (c *Client) guardar(id string, f Faixa) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.cache) >= maxCache {
		// Despejo burro: a ordem do mapa em Go já é aleatória, e para um
		// cache de prévia qualquer vítima serve. LRU aqui seria peso sem
		// ganho.
		for k := range c.cache {
			delete(c.cache, k)
			if len(c.cache) < maxCache {
				break
			}
		}
	}
	c.cache[id] = entrada{faixa: f, expira: c.agora().Add(c.ttl)}
}

func (c *Client) resolverHost(ctx context.Context) (string, error) {
	c.mu.Lock()
	if c.host != "" && c.agora().Before(c.hostAte) {
		h := c.host
		c.mu.Unlock()
		return h, nil
	}
	c.mu.Unlock()

	var body struct {
		Data []string `json:"data"`
	}
	if err := c.pegarJSON(ctx, c.discovery, &body); err != nil {
		return "", fmt.Errorf("audius: discovery: %w", err)
	}
	if len(body.Data) == 0 {
		return "", errors.New("audius: nenhum host disponível")
	}
	h := body.Data[rand.Intn(len(body.Data))]

	c.mu.Lock()
	c.host, c.hostAte = h, c.agora().Add(ttlHost)
	c.mu.Unlock()
	return h, nil
}

func (c *Client) pegarJSON(ctx context.Context, alvo string, destino any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, alvo, nil)
	if err != nil {
		return err
	}
	req.Header.Set("accept", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return ErrNaoEncontrada
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("audius: respondeu %d", res.StatusCode)
	}
	return json.NewDecoder(res.Body).Decode(destino)
}

func primeira(m map[string]string, chaves ...string) string {
	for _, k := range chaves {
		if v := m[k]; v != "" {
			return v
		}
	}
	return ""
}
