package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/thiagotn/ondas/api/internal/auth"
)

type chaveCtx string

const chaveUsuario chaveCtx = "usuario"

// comUsuario/usuarioDe isolam a chave do contexto: os dois caminhos de
// autenticação (cookie e token do bot) gravam o usuário do mesmo jeito, e os
// handlers leem sem repetir o type assertion.
func comUsuario(ctx context.Context, user *auth.User) context.Context {
	return context.WithValue(ctx, chaveUsuario, user)
}

func usuarioDe(ctx context.Context) *auth.User {
	user, _ := ctx.Value(chaveUsuario).(*auth.User)
	return user
}

// clienteIP confia no CF-Connecting-IP porque o único caminho de entrada do
// cluster é o túnel da Cloudflare — o RemoteAddr aqui é sempre o IP interno do
// Traefik, que serviria de nada para contar tentativas.
func clienteIP(r *http.Request) string {
	if ip := r.Header.Get("CF-Connecting-IP"); ip != "" {
		return ip
	}
	if ip := r.Header.Get("X-Forwarded-For"); ip != "" {
		return strings.TrimSpace(strings.Split(ip, ",")[0])
	}
	return r.RemoteAddr
}

// exigirSessao recusa com 401 quem não tem cookie válido. O cliente trata 401
// como "sessão expirada" e volta para o login — por isso a resposta é sempre
// JSON, nunca um redirect.
func (s *Server) exigirSessao(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(s.cfg.SessionCookie)
		if err != nil {
			escreverErro(w, http.StatusUnauthorized, "sessão expirada")
			return
		}
		userID, err := s.sessions.Verify(cookie.Value)
		if err != nil {
			s.limparCookie(w)
			escreverErro(w, http.StatusUnauthorized, "sessão expirada")
			return
		}
		user, err := s.users.ByID(r.Context(), userID)
		if err != nil {
			// Conta apagada com cookie ainda válido na mão: trate como sessão
			// morta em vez de 500.
			s.limparCookie(w)
			escreverErro(w, http.StatusUnauthorized, "sessão expirada")
			return
		}
		next.ServeHTTP(w, r.WithContext(comUsuario(r.Context(), user)))
	})
}
