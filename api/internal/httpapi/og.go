package httpapi

import (
	"errors"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/thiagotn/ondas/api/internal/audius"
)

// Prévia de link (Open Graph).
//
// A PWA é estática, então o robô do WhatsApp que busca a prévia recebe um
// HTML sem nada específico da faixa. O nginx manda **só os robôs** para cá
// (ver o `map` de User-Agent em `packages/web/nginx.conf`); gente continua
// recebendo o `index.html` e a SPA.

// Leitura do token do link. É uma PORTA do que está em
// `packages/core/src/share.ts`, não um import: a imagem desta API é
// construída com o contexto `api/` apenas, então nada aqui pode depender de
// arquivo do monorepo — nem o teste. A tabela de casos do teste TS está
// repetida em `og_test.go` de propósito.
var (
	tokenPublico = regexp.MustCompile(`^[A-Za-z0-9]{3,32}$`)
	tokenPrivado = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)
)

const maxSegmento = 120

// idDoToken lê o segmento de `/t/<seg>`.
//
// `privado` é faixa do acervo: dela não se diz nada, nem que existe.
func idDoToken(seg string) (publico string, privado bool, ok bool) {
	if seg == "" || len(seg) > maxSegmento {
		return "", false, false
	}
	if resto, achou := strings.CutPrefix(seg, "_"); achou {
		return "", true, tokenPrivado.MatchString(resto)
	}
	token := seg
	if i := strings.LastIndex(seg, "-"); i >= 0 {
		token = seg[i+1:]
	}
	if !tokenPublico.MatchString(token) {
		return "", false, false
	}
	return token, false, true
}

type dadosOG struct {
	Titulo    string
	Descricao string
	Capa      string
	URL       string
	Grande    bool
	Duracao   int
}

// Um HTML mínimo. `html/template` e não concatenação: título e artista vêm do
// Audius, isto é, de terceiro, e vão parar dentro de atributo.
var tmplOG = template.Must(template.New("og").Parse(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>{{.Titulo}}</title>
<link rel="canonical" href="{{.URL}}">
<meta property="og:site_name" content="ondas">
<meta property="og:type" content="music.song">
<meta property="og:title" content="{{.Titulo}}">
<meta property="og:description" content="{{.Descricao}}">
<meta property="og:url" content="{{.URL}}">
{{if .Capa}}<meta property="og:image" content="{{.Capa}}">{{end}}
{{if .Duracao}}<meta property="music:duration" content="{{.Duracao}}">{{end}}
<meta name="twitter:card" content="{{if .Grande}}summary_large_image{{else}}summary{{end}}">
<meta name="description" content="{{.Descricao}}">
<meta http-equiv="refresh" content="0;url={{.URL}}">
</head>
<body><a href="{{.URL}}">{{.Titulo}}</a></body>
</html>
`))

func (s *Server) ogFaixa(w http.ResponseWriter, r *http.Request) {
	seg := chi.URLParam(r, "seg")
	id, privado, ok := idDoToken(seg)
	destino := s.cfg.OrigemPWA + "/t/" + seg

	// Faixa do acervo: a MESMA resposta para qualquer id, existindo ou não.
	// Um 404 diferenciado já contaria a um estranho que aquele uuid existe, e
	// é por isso que nada aqui toca o banco.
	if privado || !ok {
		texto := "faixa privada — entre para ouvir."
		if !ok {
			texto = "link de faixa inválido."
			destino = s.cfg.OrigemPWA
		}
		w.Header().Set("X-Robots-Tag", "noindex")
		s.escreverOG(w, dadosOG{Titulo: "ondas", Descricao: texto, URL: destino}, false)
		return
	}

	// Rota pública que faz chamada externa: sem freio ela vira um proxy de
	// graça para o Audius.
	if s.ogLimiter != nil && !s.ogLimiter.Permitido(clienteIP(r)) {
		s.escreverOG(w, dadosOG{Titulo: "ondas", Descricao: semPrevia, URL: destino}, false)
		return
	}

	faixa, err := s.audius.Faixa(r.Context(), id)
	if err != nil {
		// Nunca 4xx aqui: vários desembrulhadores desistem da prévia em erro,
		// e o resultado seria link cru em vez de cartão genérico.
		if !errors.Is(err, audius.ErrNaoEncontrada) {
			// Erro de rede é nosso problema, não do link; o id não é segredo.
			slog.Warn("prévia de link sem metadados", "id", id, "erro", err)
		}
		s.escreverOG(w, dadosOG{Titulo: "ondas", Descricao: semPrevia, URL: destino}, false)
		return
	}

	descricao := faixa.Artista
	if faixa.Genero != "" {
		descricao += " · #" + faixa.Genero
	}
	if faixa.Duracao > 0 {
		descricao += fmt.Sprintf(" · %d:%02d", faixa.Duracao/60, faixa.Duracao%60)
	}
	s.escreverOG(w, dadosOG{
		Titulo:    faixa.Titulo,
		Descricao: descricao,
		Capa:      faixa.Capa,
		URL:       destino,
		Grande:    faixa.Capa != "",
		Duracao:   faixa.Duracao,
	}, true)
}

const semPrevia = "faixa não encontrada — o link pode estar velho."

// escreverOG é o único lugar da API que responde cacheável: a prévia é
// pública e não muda. `escreverJSON` força `no-store`, que é o certo para
// todo o resto.
func (s *Server) escreverOG(w http.ResponseWriter, d dadosOG, cacheavel bool) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if cacheavel {
		w.Header().Set("Cache-Control", "public, max-age=3600")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=60")
	}
	w.WriteHeader(http.StatusOK)
	_ = tmplOG.Execute(w, d)
}
