package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/thiagotn/ondas/api/internal/acervo"
	"github.com/thiagotn/ondas/api/internal/auth"
)

// Palavra que publica para qualquer conta, hoje e no futuro. Vem do pedido em
// vez de ser um booleano porque é o mesmo campo que recebe um e-mail — um só
// `para` cobre as três respostas que a skill do Telegram oferece.
const destinoTodos = "todos"

// Teto de e-mails por pedido de compartilhamento. Generoso para o uso real
// (uma instância de família) e baixo o bastante para um pedido absurdo não
// virar trabalho de banco.
const maxDestinatarios = 32

// Recusa ÚNICA do destino. A mensagem é a mesma para "fora de
// INGEST_DESTINOS", "e-mail que não existe" e "e-mail malformado", e isso é a
// regra, não descuido: um token vazado que conseguisse distinguir os casos
// viraria um enumerador de contas, tentando e-mail por e-mail e lendo a
// diferença entre as respostas.
const erroDestino = "destino não disponível"

// resolverDestino traduz o `para` do pedido em dono + visibilidade da faixa.
//
//	vazio    → a faixa é de quem pediu, privada (o comportamento de sempre)
//	"todos"  → a faixa é de quem pediu, visível para qualquer conta
//	um e-mail→ a faixa nasce NA CONTA daquela pessoa
//
// O terceiro caso é o que amplia o alcance do token de máquina, e é por isso
// que ele é o único que passa por `INGEST_DESTINOS`. Sessão não passa: pessoa
// logada decidindo para quem manda a própria faixa é ato normal.
func (s *Server) resolverDestino(w http.ResponseWriter, r *http.Request, para string) (acervo.Destino, bool) {
	para = strings.TrimSpace(para)
	if para == "" {
		return acervo.Destino{}, true
	}
	if strings.EqualFold(para, destinoTodos) {
		// Dono continua sendo quem pediu: "todos" é uma propriedade da faixa,
		// não uma pessoa. Sem isso não haveria dono para a linha.
		return acervo.Destino{Visibilidade: acervo.VisibilidadeTodos}, true
	}

	if porTokenDe(r.Context()) && !s.cfg.DestinoPermitidoPorToken(para) {
		// Log com o e-mail tentado, porque aqui dentro a informação é útil e
		// não sai na resposta.
		slog.Warn("destino recusado para token", "destino", para, "ip", clienteIP(r))
		escreverErro(w, http.StatusBadRequest, erroDestino)
		return acervo.Destino{}, false
	}

	dono, err := s.users.PorEmail(r.Context(), para)
	if errors.Is(err, auth.ErrNaoEncontrado) {
		escreverErro(w, http.StatusBadRequest, erroDestino)
		return acervo.Destino{}, false
	}
	if err != nil {
		slog.Error("resolver destino", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível resolver o destino")
		return acervo.Destino{}, false
	}
	return acervo.Destino{UserID: dono.ID, Visibilidade: acervo.VisibilidadePrivada}, true
}

// compartilhar muda com quem uma faixa do acervo é dividida.
//
// Corpo, todos os campos opcionais:
//
//	{"visibilidade": "todos"|"privada", "com": ["e-mail", …], "sem": ["e-mail", …]}
//
// Responde o estado INTEIRO que ficou, e não 204, seguindo `DefinirPublico` e
// `aplicarLikes`: quem chama fica com o que foi gravado, sem uma segunda
// leitura que possa discordar da escrita.
//
// Só sessão, e isto é desenho: compartilhar é mexer no acervo que já existe, que
// é exatamente o que o token de máquina não faz (ver os dois grupos de rota em
// `server.go`).
func (s *Server) compartilhar(w http.ResponseWriter, r *http.Request) {
	user := usuarioDe(r.Context())
	id, ok := idDaRota(w, r)
	if !ok {
		return
	}
	var req struct {
		Visibilidade string   `json:"visibilidade"`
		Com          []string `json:"com"`
		Sem          []string `json:"sem"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	req.Visibilidade = strings.TrimSpace(req.Visibilidade)
	if req.Visibilidade != "" && !acervo.VisibilidadeValida(req.Visibilidade) {
		escreverErro(w, http.StatusBadRequest, "visibilidade inválida")
		return
	}
	if len(req.Com)+len(req.Sem) > maxDestinatarios {
		escreverErro(w, http.StatusBadRequest, "destinatários demais num pedido")
		return
	}

	// As duas listas são resolvidas de e-mail para id ANTES de qualquer escrita:
	// um e-mail desconhecido no meio do caminho deixaria o pedido pela metade.
	com, ok := s.idsDeEmails(w, r, req.Com)
	if !ok {
		return
	}
	sem, ok := s.idsDeEmails(w, r, req.Sem)
	if !ok {
		return
	}
	// Disjuntas: o mesmo e-mail nas duas listas é pedido confuso, e resolver na
	// marra (deixando o `com` ganhar, como a ordem do SQL faria) esconderia o
	// erro de quem montou o pedido.
	for _, a := range com {
		for _, b := range sem {
			if a == b {
				escreverErro(w, http.StatusBadRequest, "o mesmo destino em `com` e `sem`")
				return
			}
		}
	}

	vis, concedidos, err := s.tracks.AplicarCompartilhamento(
		r.Context(), user.ID, id, req.Visibilidade, com, sem)
	if errors.Is(err, acervo.ErrNaoEncontrada) {
		// 404 e não 403: para quem não é dono, a faixa não existe — a mesma
		// régua de `PorID`, que não deixa um id alheio confirmar nada.
		escreverErro(w, http.StatusNotFound, "faixa não encontrada")
		return
	}
	if err != nil {
		slog.Error("compartilhar faixa", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível compartilhar")
		return
	}

	nomes, err := s.users.NomesPorIDs(r.Context(), concedidos)
	if err != nil {
		slog.Error("nomes das concessões", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível compartilhar")
		return
	}
	// Devolve NOME e não e-mail, pelo mesmo motivo de `trackJSON.Owner`: quem
	// compartilhou já sabe para quem mandou, e a resposta não precisa carregar
	// o e-mail de ninguém de volta pela rede.
	escreverJSON(w, http.StatusOK, map[string]any{"visibilidade": vis, "com": nomes})
}

// idsDeEmails traduz a lista do pedido, recusando o pedido inteiro no primeiro
// e-mail que não existe.
//
// Usa `erroDestino` — a mesma recusa de `resolverDestino` — por consistência,
// embora aqui a enumeração não seja a preocupação (esta rota exige sessão, e
// quem tem conta não aprende nada relevante descobrindo que outra existe).
func (s *Server) idsDeEmails(w http.ResponseWriter, r *http.Request, emails []string) ([]string, bool) {
	ids := make([]string, 0, len(emails))
	for _, e := range emails {
		e = strings.TrimSpace(e)
		if e == "" {
			continue
		}
		u, err := s.users.PorEmail(r.Context(), e)
		if errors.Is(err, auth.ErrNaoEncontrado) {
			escreverErro(w, http.StatusBadRequest, erroDestino)
			return nil, false
		}
		if err != nil {
			slog.Error("resolver destinatário", "erro", err)
			escreverErro(w, http.StatusInternalServerError, "não foi possível compartilhar")
			return nil, false
		}
		ids = append(ids, u.ID)
	}
	return ids, true
}
