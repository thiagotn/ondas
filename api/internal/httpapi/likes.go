package httpapi

import (
	"log/slog"
	"net/http"
)

// Teto do corpo do PATCH. Maior que o padrão de `lerJSON` porque a primeira
// sincronização de um aparelho sobe a coleção inteira de uma vez.
const limiteCorpoLikes = 64 << 10

// Teto da lista, que é outro problema do teto do corpo: aquele protege a nossa
// memória, este protege o banco de um `unnest` de tamanho arbitrário.
const maxIDsPorPedido = 1000

// Um id de faixa é um id do Audius (curto) ou `acervo:<uuid>` (43 caracteres).
// 128 é folga suficiente para qualquer fonte futura e curto o bastante para
// nada virar depósito de texto.
const maxTamanhoID = 128

func (s *Server) listarLikes(w http.ResponseWriter, r *http.Request) {
	ids, err := s.likes.Listar(r.Context(), usuarioDe(r.Context()).ID)
	if err != nil {
		slog.Error("listar curtidas", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível ler as curtidas")
		return
	}
	escreverJSON(w, http.StatusOK, map[string]any{"ids": ids})
}

// aplicarLikes recebe as duas listas e responde a coleção inteira que ficou.
//
// Uma rota só, com `add` e `remove`, cobre os três usos do cliente com um
// handler: o toque no coração (`add` com um id), a fila que acumulou sem rede,
// e a adoção das curtidas que já estavam no aparelho antes desta tabela
// existir. Um `PUT`/`DELETE` por id pediria N viagens para a fila e para a
// adoção.
func (s *Server) aplicarLikes(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Add    []string `json:"add"`
		Remove []string `json:"remove"`
	}
	if !lerJSONAte(w, r, &req, limiteCorpoLikes) {
		return
	}
	if len(req.Add)+len(req.Remove) > maxIDsPorPedido || !idsValidos(req.Add) || !idsValidos(req.Remove) {
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return
	}

	ids, err := s.likes.Aplicar(r.Context(), usuarioDe(r.Context()).ID, req.Add, req.Remove)
	if err != nil {
		slog.Error("aplicar curtidas", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível salvar as curtidas")
		return
	}
	escreverJSON(w, http.StatusOK, map[string]any{"ids": ids})
}

func idsValidos(ids []string) bool {
	for _, id := range ids {
		if id == "" || len(id) > maxTamanhoID {
			return false
		}
	}
	return true
}
