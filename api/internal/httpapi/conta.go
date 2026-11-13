package httpapi

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/thiagotn/ondas/api/internal/auth"
)

// A conta administrando a si mesma: nome, senha, e ir embora.
//
// As duas ações sem volta — trocar a senha e apagar a conta — pedem a senha
// ATUAL no corpo, mesmo com sessão válida. O cookie prova que este navegador
// entrou um dia (ele vale trinta dias); a senha prova que quem está na frente
// dele agora é a pessoa. Sem isso, um aparelho esquecido aberto bastaria para
// tomar a conta ou apagá-la.

// senhaPermitida conta a tentativa de conferir a senha e diz se ela pode
// prosseguir; quando não pode, já respondeu 429.
//
// O freio é por CONTA e não por IP: aqui o atacante já tem a sessão, e trocar
// de IP não pode zerar a contagem de tentativas contra a senha de alguém.
func (s *Server) senhaPermitida(w http.ResponseWriter, userID string) bool {
	if !s.senhaLimiter.Permitido(userID) {
		slog.Warn("senha bloqueada por tentativas", "conta", userID)
		escreverErro(w, http.StatusTooManyRequests, "muitas tentativas — espere alguns minutos")
		return false
	}
	return true
}

// contaSumiu trata a conta apagada com cookie válido na mão, como o middleware.
func (s *Server) contaSumiu(w http.ResponseWriter) {
	s.limparCookie(w)
	escreverErro(w, http.StatusUnauthorized, "sessão expirada")
}

func (s *Server) renomearConta(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	user, err := s.users.Renomear(r.Context(), usuarioDe(r.Context()).ID, req.Name)
	switch {
	case errors.Is(err, auth.ErrNomeInvalido):
		escreverErro(w, http.StatusBadRequest, err.Error())
		return
	case errors.Is(err, auth.ErrNaoEncontrado):
		s.contaSumiu(w)
		return
	case err != nil:
		slog.Error("renomear conta", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível salvar a conta")
		return
	}
	// O `User` inteiro, como o PATCH de prefs: quem chama fica com o que foi
	// gravado, sem uma segunda leitura.
	escreverJSON(w, http.StatusOK, user)
}

func (s *Server) trocarSenha(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Atual string `json:"atual"`
		Nova  string `json:"nova"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	userID := usuarioDe(r.Context()).ID
	if !s.senhaPermitida(w, userID) {
		return
	}
	err := s.users.TrocarSenha(r.Context(), userID, req.Atual, req.Nova)
	switch {
	case errors.Is(err, auth.ErrSenhaCurta):
		escreverErroCod(w, http.StatusBadRequest, CodSenhaCurta, err.Error(),
			map[string]any{"minimo": auth.SenhaMinima})
		return
	case errors.Is(err, auth.ErrSenhaInvalida):
		// 403 e nunca 401: o cliente lê 401 como sessão morta e mandaria a
		// pessoa de volta ao login no meio de um erro de digitação.
		escreverErro(w, http.StatusForbidden, "senha atual incorreta")
		return
	case errors.Is(err, auth.ErrNaoEncontrado):
		s.contaSumiu(w)
		return
	case err != nil:
		slog.Error("trocar senha", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível salvar a conta")
		return
	}
	s.senhaLimiter.Esquecer(userID)
	slog.Info("senha trocada", "conta", userID)
	escreverJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// apagarConta remove a conta e tudo que é dela.
//
// As faixas saem ANTES da conta, uma a uma, pelo mesmo caminho do DELETE de uma
// faixa. O `ON DELETE CASCADE` de `tracks` apagaria as linhas sozinho, mas não
// os objetos no R2 — e nem as curtidas, itens de playlist e histórico que
// OUTRAS contas têm de uma faixa compartilhada, que não têm FK para `tracks`.
//
// Se uma faixa falhar, a conta NÃO é apagada: o pedido responde erro e pode ser
// repetido, e as faixas que já saíram simplesmente não estão mais lá. O
// contrário — apagar a conta e deixar faixa para trás — perderia o dono das
// keys, e ninguém mais saberia o que limpar no bucket.
func (s *Server) apagarConta(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Senha string `json:"senha"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	ctx := r.Context()
	userID := usuarioDe(ctx).ID
	if !s.senhaPermitida(w, userID) {
		return
	}
	err := s.users.ConferirSenha(ctx, userID, req.Senha)
	switch {
	case errors.Is(err, auth.ErrSenhaInvalida):
		escreverErro(w, http.StatusForbidden, "senha atual incorreta")
		return
	case errors.Is(err, auth.ErrNaoEncontrado):
		s.contaSumiu(w)
		return
	case err != nil:
		slog.Error("apagar conta: conferir senha", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível apagar a conta")
		return
	}
	s.senhaLimiter.Esquecer(userID)

	ids, err := s.tracks.IDsDoDono(ctx, userID)
	if err != nil {
		slog.Error("apagar conta: listar faixas", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível apagar a conta")
		return
	}
	for _, id := range ids {
		if err := s.apagarFaixa(ctx, userID, id); err != nil {
			slog.Error("apagar conta: faixa", "faixa", id, "erro", err)
			escreverErro(w, http.StatusInternalServerError, "não foi possível apagar a conta")
			return
		}
	}
	if err := s.users.Apagar(ctx, userID); err != nil {
		slog.Error("apagar conta", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível apagar a conta")
		return
	}
	slog.Info("conta apagada pelo dono", "conta", userID, "faixas", len(ids))
	s.limparCookie(w)
	escreverJSON(w, http.StatusOK, map[string]string{"status": "apagada"})
}
