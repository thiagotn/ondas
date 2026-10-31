// Package httpapi tem o roteador e os handlers HTTP.
package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

type erroResp struct {
	Error string `json:"error"`
}

func escreverJSON(w http.ResponseWriter, status int, corpo any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	// Resposta de API nunca entra em cache: o edge da Cloudflare reescreve
	// Cache-Control de estáticos, e um /api/acervo cacheado vazaria conteúdo
	// de uma sessão para a próxima.
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(status)
	if corpo == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(corpo); err != nil {
		slog.Error("falha ao escrever resposta", "erro", err)
	}
}

// As mensagens vão em pt-BR porque a PWA as exibe cruas na tela de login.
func escreverErro(w http.ResponseWriter, status int, msg string) {
	escreverJSON(w, status, erroResp{Error: msg})
}

func lerJSON(w http.ResponseWriter, r *http.Request, destino any) bool {
	return lerJSONAte(w, r, destino, 4<<10)
}

// lerJSONAte é lerJSON com outro teto de corpo.
//
// Existe por causa das curtidas: a primeira sincronização de um aparelho manda
// TODAS as curtidas que já estavam nele de uma vez, e algumas centenas de ids
// passam folgado dos 4 KiB do padrão. O 400 que sairia dali diria "requisição
// inválida" para um pedido perfeitamente válido, e ninguém acharia o motivo.
//
// O teto continua existindo, só que maior: `MaxBytesReader` é o que impede um
// corpo infinito de virar memória nossa.
func lerJSONAte(w http.ResponseWriter, r *http.Request, destino any, limite int64) bool {
	defer r.Body.Close()
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limite))
	dec.DisallowUnknownFields()
	if err := dec.Decode(destino); err != nil {
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return false
	}
	return true
}
