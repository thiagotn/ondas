package httpapi

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/thiagotn/ondas/api/internal/auth"
)

// As rotas de `/api/admin`: quem entra na plataforma e quem pode enviar arquivo.
//
// Não há tela para isto. Quem consome é a `ondasctl` (cmd/ondasctl), e a
// resposta é sempre a `auth.Conta` — o registro como o admin o vê, com id,
// e-mail e a mensagem do pedido, que o `User` do navegador esconde.

// O cabeçalho do admin. Outro nome que o do bot (`X-Ondas-Token`) para um nunca
// ser aceito no lugar do outro por engano de configuração.
const cabecalhoAdmin = "X-Ondas-Admin-Token"

// exigirAdmin só deixa passar quem traz o token de admin.
//
// Sem `ADMIN_TOKEN_SHA256` configurado a resposta é 404, e não 401 ou 503: a
// administração desligada tem de ser indistinguível de uma rota que não existe,
// para ninguém ficar sabendo que há uma porta ali esperando a chave.
//
// Toda tentativa conta no freio por IP, e só o acerto zera — o mesmo desenho do
// login. O token tem 256 bits e não cai por força bruta; o freio é para o
// barulho não virar carga.
func (s *Server) exigirAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.cfg.AdminConfigurado() {
			http.NotFound(w, r)
			return
		}
		ip := clienteIP(r)
		if !s.adminLimiter.Permitido(ip) {
			slog.Warn("admin bloqueado por tentativas", "ip", ip)
			escreverErro(w, http.StatusTooManyRequests, "muitas tentativas — espere alguns minutos")
			return
		}
		token := r.Header.Get(cabecalhoAdmin)
		if token == "" {
			escreverErro(w, http.StatusUnauthorized, "token inválido")
			return
		}
		if err := confereToken(token, s.cfg.AdminTokenSHA256); err != nil {
			slog.Warn("token de admin recusado", "ip", ip, "erro", err)
			escreverErro(w, http.StatusUnauthorized, "token inválido")
			return
		}
		s.adminLimiter.Esquecer(ip)
		next.ServeHTTP(w, r)
	})
}

// idDaConta valida o id antes de ir ao banco, como `idDaRota`: um id que não é
// uuid faria o pgx devolver erro de sintaxe, e a resposta seria 500 onde 404 é
// o certo.
func idDaConta(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := chi.URLParam(r, "id")
	if _, err := uuid.Parse(id); err != nil {
		escreverErro(w, http.StatusNotFound, "conta não encontrada")
		return "", false
	}
	return id, true
}

// listarContas devolve as contas, da mais antiga para a mais nova.
//
//	?status=pendente|aprovada|negada   recorta por estado (sem ele, todas)
//	?email=…                           a conta deste e-mail (é como a CLI
//	                                   resolve `aprovar fulano@…` em um id)
func (s *Server) listarContas(w http.ResponseWriter, r *http.Request) {
	filtro := auth.Filtro{
		Status: r.URL.Query().Get("status"),
		Email:  r.URL.Query().Get("email"),
	}
	if filtro.Status != "" && !auth.StatusValido(filtro.Status) {
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return
	}
	contas, err := s.users.Listar(r.Context(), filtro)
	if err != nil {
		slog.Error("admin: listar contas", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível ler as contas")
		return
	}
	escreverJSON(w, http.StatusOK, map[string]any{"contas": contas})
}

func (s *Server) aprovarConta(w http.ResponseWriter, r *http.Request) {
	s.decidirConta(w, r, auth.StatusAprovada)
}

func (s *Server) negarConta(w http.ResponseWriter, r *http.Request) {
	s.decidirConta(w, r, auth.StatusNegada)
}

// decidirConta aprova ou nega. Serve também para voltar atrás — negar quem já
// estava aprovado é como se suspende uma conta, e vale no pedido seguinte dela
// (ver `exigirSessao`).
func (s *Server) decidirConta(w http.ResponseWriter, r *http.Request, status string) {
	id, ok := idDaConta(w, r)
	if !ok {
		return
	}
	conta, err := s.users.Decidir(r.Context(), id, status)
	if errors.Is(err, auth.ErrNaoEncontrado) {
		escreverErro(w, http.StatusNotFound, "conta não encontrada")
		return
	}
	if err != nil {
		slog.Error("admin: decidir conta", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível salvar a conta")
		return
	}
	slog.Info("admin: conta decidida", "conta", conta.ID, "status", conta.Status, "ip", clienteIP(r))
	escreverJSON(w, http.StatusOK, conta)
}

// definirEnvio liga ou desliga o direito de entrar com faixa nova.
//
// O campo é PONTEIRO pelo mesmo motivo do `publico` em `prefs`: com `bool`, um
// corpo sem a chave decodificaria para `false` e tiraria o envio de alguém por
// causa de um JSON errado.
func (s *Server) definirEnvio(w http.ResponseWriter, r *http.Request) {
	id, ok := idDaConta(w, r)
	if !ok {
		return
	}
	var req struct {
		PodeEnviar *bool `json:"podeEnviar"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	if req.PodeEnviar == nil {
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return
	}
	conta, err := s.users.DefinirEnvio(r.Context(), id, *req.PodeEnviar)
	if errors.Is(err, auth.ErrNaoEncontrado) {
		escreverErro(w, http.StatusNotFound, "conta não encontrada")
		return
	}
	if err != nil {
		slog.Error("admin: definir envio", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível salvar a conta")
		return
	}
	slog.Info("admin: envio definido", "conta", conta.ID, "podeEnviar", conta.PodeEnviar, "ip", clienteIP(r))
	escreverJSON(w, http.StatusOK, conta)
}
