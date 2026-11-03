package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/thiagotn/ondas/api/internal/playlists"
)

// idDePlaylist valida o id antes de ir ao banco, como `idDaRota` faz com a
// faixa: um id que não é uuid faria o pgx devolver erro de sintaxe, e o handler
// responderia 500 onde 404 é o certo.
//
// Separada de `idDaRota` porque esta NÃO tolera o prefixo `acervo:` — ele é da
// faixa, e aceitá-lo aqui só esconderia um id trocado de lugar — e porque a
// mensagem de 404 é outra.
func idDePlaylist(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := chi.URLParam(r, "id")
	if _, err := uuid.Parse(id); err != nil {
		escreverErro(w, http.StatusNotFound, "playlist não encontrada")
		return "", false
	}
	return id, true
}

// nomeValido peneira o nome que veio por JSON.
//
// Recusa caractere de controle junto com o vazio e o longo: o nome é impresso
// cru na fileira de chips e no prompt (`ondas ls --playlist="treino"`), e um
// `\n` ou um `\r` ali quebraria a linha do terminal em duas.
func nomeValido(nome string) bool {
	if nome == "" || utf8.RuneCountInString(nome) > playlists.MaxNome {
		return false
	}
	for _, r := range nome {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// responderPlaylists é a resposta de TODAS as rotas deste arquivo: a coleção
// inteira que ficou. Ver o comentário do pacote `playlists` para o porquê.
func responderPlaylists(w http.ResponseWriter, status int, todas []playlists.Playlist) {
	escreverJSON(w, status, map[string]any{"playlists": todas})
}

// erroDePlaylist traduz os erros do store nos status certos, num lugar só —
// são cinco handlers com o mesmo vocabulário.
func (s *Server) erroDePlaylist(w http.ResponseWriter, acao string, err error) {
	switch {
	case errors.Is(err, playlists.ErrNaoEncontrada):
		// 404 e não 403: para quem não é dono, a playlist não existe — a mesma
		// régua de `acervo.PorID`, que não deixa um id alheio confirmar nada.
		escreverErro(w, http.StatusNotFound, "playlist não encontrada")
	case errors.Is(err, playlists.ErrNomeEmUso):
		// 409, como o cadastro responde a e-mail em uso.
		escreverErro(w, http.StatusConflict, err.Error())
	case errors.Is(err, playlists.ErrDemasiadas):
		escreverErroCod(w, http.StatusBadRequest, CodPlaylistLimiteContas, err.Error(),
			map[string]any{"limite": playlists.MaxPorConta})
	case errors.Is(err, playlists.ErrItensDemais):
		escreverErroCod(w, http.StatusBadRequest, CodPlaylistLimiteFaixas, err.Error(),
			map[string]any{"limite": playlists.MaxItens})
	default:
		slog.Error(acao, "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível salvar a playlist")
	}
}

func (s *Server) listarPlaylists(w http.ResponseWriter, r *http.Request) {
	todas, err := s.playlists.Listar(r.Context(), usuarioDe(r.Context()).ID)
	if err != nil {
		slog.Error("listar playlists", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível ler as playlists")
		return
	}
	responderPlaylists(w, http.StatusOK, todas)
}

func (s *Server) criarPlaylist(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Nome string `json:"nome"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	nome := strings.TrimSpace(req.Nome)
	if !nomeValido(nome) {
		escreverErro(w, http.StatusBadRequest, "nome inválido")
		return
	}
	todas, err := s.playlists.Criar(r.Context(), usuarioDe(r.Context()).ID, nome)
	if err != nil {
		s.erroDePlaylist(w, "criar playlist", err)
		return
	}
	responderPlaylists(w, http.StatusCreated, todas)
}

func (s *Server) renomearPlaylist(w http.ResponseWriter, r *http.Request) {
	id, ok := idDePlaylist(w, r)
	if !ok {
		return
	}
	var req struct {
		Nome string `json:"nome"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	nome := strings.TrimSpace(req.Nome)
	if !nomeValido(nome) {
		escreverErro(w, http.StatusBadRequest, "nome inválido")
		return
	}
	todas, err := s.playlists.Renomear(r.Context(), usuarioDe(r.Context()).ID, id, nome)
	if err != nil {
		s.erroDePlaylist(w, "renomear playlist", err)
		return
	}
	responderPlaylists(w, http.StatusOK, todas)
}

func (s *Server) apagarPlaylist(w http.ResponseWriter, r *http.Request) {
	id, ok := idDePlaylist(w, r)
	if !ok {
		return
	}
	todas, err := s.playlists.Apagar(r.Context(), usuarioDe(r.Context()).ID, id)
	if err != nil {
		s.erroDePlaylist(w, "apagar playlist", err)
		return
	}
	responderPlaylists(w, http.StatusOK, todas)
}

// aplicarItensDaPlaylist tira, põe e reordena num pedido só.
//
//	{"add": [id, …], "remove": [id, …], "ordem": [id, …]}
//
// Uma rota para os três gestos, como `aplicarLikes` cobre os três usos da
// curtida com um handler: o modo de seleção manda `add` sem conhecer o conteúdo
// da playlist de destino, a barra manda `remove`, e o `J`/`K` manda `ordem` com
// a lista inteira como ela deve ficar. Um `PUT`/`DELETE` por item pediria N
// viagens para adicionar as faixas marcadas.
func (s *Server) aplicarItensDaPlaylist(w http.ResponseWriter, r *http.Request) {
	id, ok := idDePlaylist(w, r)
	if !ok {
		return
	}
	var req struct {
		Add    []string `json:"add"`
		Remove []string `json:"remove"`
		Ordem  []string `json:"ordem"`
	}
	// O mesmo teto de corpo das curtidas, pela mesma razão: `ordem` carrega a
	// playlist inteira, e algumas centenas de ids passam folgado dos 4 KiB do
	// padrão de `lerJSON`.
	if !lerJSONAte(w, r, &req, limiteCorpoLikes) {
		return
	}
	if len(req.Add)+len(req.Remove)+len(req.Ordem) > maxIDsPorPedido ||
		!idsValidos(req.Add) || !idsValidos(req.Remove) || !idsValidos(req.Ordem) {
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return
	}
	// Disjuntas, como em `compartilhar`: o mesmo id em `add` e `remove` é
	// pedido confuso, e resolver na marra (deixando a ordem do SQL decidir)
	// esconderia o erro de quem montou o pedido.
	for _, a := range req.Add {
		for _, b := range req.Remove {
			if a == b {
				escreverErro(w, http.StatusBadRequest, "o mesmo id em `add` e `remove`")
				return
			}
		}
	}

	todas, err := s.playlists.AplicarItens(
		r.Context(), usuarioDe(r.Context()).ID, id, req.Add, req.Remove, req.Ordem)
	if err != nil {
		s.erroDePlaylist(w, "aplicar itens da playlist", err)
		return
	}
	responderPlaylists(w, http.StatusOK, todas)
}
