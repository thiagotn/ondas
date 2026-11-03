// Package httpapi tem o roteador e os handlers HTTP.
package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

type erroResp struct {
	// A frase em pt-BR. Continua aqui para cliente antigo e para `curl`; a PWA
	// só cai nela quando não reconhece o `Code`.
	Error string `json:"error"`
	// O que aconteceu, estável e sem idioma. Ver `erros.go`.
	Code string `json:"code,omitempty"`
	// Números que a frase precisa (um teto, um limite). Vão crus para quem
	// desenha a tela formatar no locale de quem lê.
	Params map[string]any `json:"params,omitempty"`
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

// escreverErro responde com a frase em pt-BR E o código correspondente, que
// sai da tabela em `erros.go`. Mensagem sem código vai só com a frase — é o
// comportamento de antes, e `TestTodoErroTemCodigo` cobre o esquecimento.
func escreverErro(w http.ResponseWriter, status int, msg string) {
	escreverJSON(w, status, erroResp{Error: msg, Code: codigoPorMensagem[msg]})
}

// escreverErroCod é escreverErro para o que a tabela não alcança: frase montada
// com número dentro. O número vai separado, em `params`, porque em en e es ele
// não cai no mesmo lugar da frase.
func escreverErroCod(w http.ResponseWriter, status int, cod, msg string, params map[string]any) {
	escreverJSON(w, status, erroResp{Error: msg, Code: cod, Params: params})
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
