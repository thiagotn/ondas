package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/thiagotn/ondas/api/internal/admin"
	"github.com/thiagotn/ondas/api/internal/auth"
)

// As rotas de `/api/admin`: quem entra na plataforma, o que cada conta pode e
// quanto ela ocupa.
//
// Dois clientes falam com elas. A `ondasctl` (cmd/ondasctl) manda o token de
// admin no cabeçalho a cada pedido; o painel (`packages/admin`) troca o token
// por um cookie uma vez e segue com ele. Nos dois casos a credencial é a MESMA
// — o token de admin —, e nenhum dos dois é uma conta de usuário: não existe
// papel de admin em `users`.

// O cabeçalho do admin. Outro nome que o do bot (`X-Ondas-Token`) para um nunca
// ser aceito no lugar do outro por engano de configuração.
const cabecalhoAdmin = "X-Ondas-Admin-Token"

// O cookie do painel. Outro nome e outro `Path` que o da sessão de usuário
// (`ondas_session`, em `/`): este só viaja para `/api/admin`, então nem a PWA
// nem o resto da API chegam a vê-lo.
const (
	cookieAdmin   = "ondas_admin"
	caminhoAdmin  = "/api/admin"
	validadeAdmin = 12 * time.Hour
	sujeitoAdmin  = "admin"
)

// sessoesAdmin assina o cookie do painel.
//
// A chave junta o segredo de sessão com a SOMA do token de admin: trocar o
// token derruba as sessões abertas do painel (quem tinha o cookie tinha o token
// antigo), e trocar `SESSION_SECRET` continua sendo o botão de pânico de tudo.
// O `|admin|` no meio separa este domínio do das sessões de usuário — um cookie
// de usuário não confere aqui nem que alguém o renomeie.
//
// Montada a cada uso, e não em `New`: é um HMAC, custa nada, e assim ela
// acompanha a configuração em vez de congelar o valor do boot.
func (s *Server) sessoesAdmin() *auth.Sessions {
	return auth.NewSessions(
		s.cfg.SessionSecret+"|admin|"+strings.TrimSpace(s.cfg.AdminTokenSHA256), validadeAdmin)
}

func (s *Server) gravarCookieAdmin(w http.ResponseWriter, valor string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name:  cookieAdmin,
		Value: valor,
		Path:  caminhoAdmin,
		// `Strict`, e não o `Lax` da sessão de usuário: este cookie decide quem
		// entra na plataforma, e nenhum fluxo legítimo chega ao painel vindo de
		// outro site com ele na mão. É também a defesa contra CSRF das rotas
		// que escrevem.
		HttpOnly: true,
		Secure:   !s.cfg.SessionInsecure,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   maxAge,
	})
}

// credencialAdmin é o que o pedido trouxe para provar que é o admin.
type credencialAdmin int

const (
	// Nem cabeçalho nem cookie: ninguém tentou nada.
	semCredencial credencialAdmin = iota
	tokenValido
	tokenRecusado
	cookieValido
	cookieRecusado
)

// adminAutenticado confere a credencial do pedido: o token no cabeçalho (a
// CLI) ou o cookie do painel.
func (s *Server) adminAutenticado(r *http.Request) credencialAdmin {
	if token := r.Header.Get(cabecalhoAdmin); token != "" {
		if err := confereToken(token, s.cfg.AdminTokenSHA256); err != nil {
			slog.Warn("token de admin recusado", "ip", clienteIP(r), "erro", err)
			return tokenRecusado
		}
		return tokenValido
	}
	cookie, err := r.Cookie(cookieAdmin)
	if err != nil {
		return semCredencial
	}
	if sujeito, err := s.sessoesAdmin().Verify(cookie.Value); err != nil || sujeito != sujeitoAdmin {
		return cookieRecusado
	}
	return cookieValido
}

// exigirAdmin só deixa passar quem traz a credencial de admin.
//
// Sem `ADMIN_TOKEN_SHA256` configurado a resposta é 404, e não 401 ou 503: a
// administração desligada tem de ser indistinguível de uma rota que não existe,
// para ninguém ficar sabendo que há uma porta ali esperando a chave.
//
// O freio por IP conta só a credencial ERRADA. O painel faz vários pedidos
// válidos em paralelo ao abrir uma tela, e pergunta "estou dentro?" sem
// credencial nenhuma toda vez que é aberto deslogado: se qualquer um desses
// contasse como tentativa, o uso normal trancaria o admin para fora. Depois do
// teto, nem a credencial certa passa até a janela andar — o mesmo desenho do
// login. O token tem 256 bits e não cai por força bruta; o freio é para o
// barulho não virar carga.
func (s *Server) exigirAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.cfg.AdminConfigurado() {
			http.NotFound(w, r)
			return
		}
		ip := clienteIP(r)
		if s.adminLimiter.Bloqueado(ip) {
			slog.Warn("admin bloqueado por tentativas", "ip", ip)
			escreverErro(w, http.StatusTooManyRequests, "muitas tentativas — espere alguns minutos")
			return
		}
		switch s.adminAutenticado(r) {
		case tokenValido:
			s.adminLimiter.Esquecer(ip)
		case cookieValido:
		case tokenRecusado:
			s.adminLimiter.Permitido(ip)
			escreverErro(w, http.StatusUnauthorized, "token inválido")
			return
		case cookieRecusado:
			s.adminLimiter.Permitido(ip)
			// Cookie vencido ou forjado: tira do navegador, para o painel não
			// ficar repetindo um pedido que nunca vai passar.
			s.gravarCookieAdmin(w, "", -1)
			escreverErro(w, http.StatusUnauthorized, "token inválido")
			return
		default:
			escreverErro(w, http.StatusUnauthorized, "token inválido")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// abrirSessaoAdmin troca o token de admin pelo cookie do painel.
//
// É o que deixa o token fora do alcance de script: ele é digitado uma vez, vai
// no corpo deste pedido, e o que fica no navegador é um cookie `HttpOnly` que
// vence em doze horas e só viaja para `/api/admin`.
func (s *Server) abrirSessaoAdmin(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.AdminConfigurado() {
		http.NotFound(w, r)
		return
	}
	ip := clienteIP(r)
	if s.adminLimiter.Bloqueado(ip) {
		slog.Warn("admin bloqueado por tentativas", "ip", ip)
		escreverErro(w, http.StatusTooManyRequests, "muitas tentativas — espere alguns minutos")
		return
	}
	var req struct {
		Token string `json:"token"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	if err := confereToken(strings.TrimSpace(req.Token), s.cfg.AdminTokenSHA256); err != nil {
		s.adminLimiter.Permitido(ip)
		slog.Warn("token de admin recusado no painel", "ip", ip, "erro", err)
		escreverErro(w, http.StatusUnauthorized, "token inválido")
		return
	}
	s.adminLimiter.Esquecer(ip)
	s.gravarCookieAdmin(w, s.sessoesAdmin().Sign(sujeitoAdmin), int(validadeAdmin.Seconds()))
	s.registrar(r, admin.Evento{Acao: "sessao.aberta"})
	escreverJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// fecharSessaoAdmin apaga o cookie. Sem autenticação de propósito: sair tem de
// funcionar com a sessão vencida, e apagar um cookie não revela nem muda nada.
func (s *Server) fecharSessaoAdmin(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.AdminConfigurado() {
		http.NotFound(w, r)
		return
	}
	s.gravarCookieAdmin(w, "", -1)
	escreverJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// sessaoAdmin é o "estou dentro?" do painel ao abrir.
func (s *Server) sessaoAdmin(w http.ResponseWriter, _ *http.Request) {
	escreverJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// registrar anota a decisão no histórico. Melhor-esforço: a decisão já valeu, e
// perder a linha não é motivo para dizer ao admin que ela não aconteceu.
func (s *Server) registrar(r *http.Request, e admin.Evento) {
	e.IP = clienteIP(r)
	if err := s.painel.Registrar(r.Context(), e); err != nil {
		slog.Error("admin: registrar evento", "acao", e.Acao, "erro", err)
	}
}

func simNao(b bool) string {
	if b {
		return "sim"
	}
	return "não"
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
	status := r.URL.Query().Get("status")
	if status != "" && !auth.StatusValido(status) {
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return
	}
	// A linha do painel: o que `auth.Conta` trazia, com os mesmos nomes (é o
	// que a `ondasctl` lê), mais faixas, ocupação, plano e atividade.
	contas, err := s.painel.Contas(r.Context(), status, r.URL.Query().Get("email"))
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
	s.registrar(r, admin.Evento{
		Acao: "conta." + conta.Status, AlvoTipo: "conta", AlvoID: conta.ID, AlvoRotulo: conta.Email,
	})
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
	s.registrar(r, admin.Evento{
		Acao: "conta.ajustada", AlvoTipo: "conta", AlvoID: conta.ID, AlvoRotulo: conta.Email,
		Detalhe: "pode enviar: " + simNao(conta.PodeEnviar),
	})
	escreverJSON(w, http.StatusOK, conta)
}
