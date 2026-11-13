package httpapi

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"

	"github.com/thiagotn/ondas/api/internal/auth"
)

type chaveCtx string

const (
	chaveUsuario chaveCtx = "usuario"
	chaveToken   chaveCtx = "porToken"
)

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

// comToken/porTokenDe guardam COMO o pedido entrou, e não só quem é.
//
// Os dois caminhos põem o mesmo `*auth.User` no contexto, o que era suficiente
// enquanto token e sessão podiam fazer exatamente as mesmas coisas. Desde que o
// pedido de ingestão pode nomear um destino (migração 0007), deixou de ser: o
// token é limitado pela lista `INGEST_DESTINOS` e a sessão não, porque limitar
// um robô e limitar gente não são a mesma decisão.
//
// O padrão é `false`, e isso importa: quem esquecer de marcar cai no caminho de
// SESSÃO, que é o menos restrito. Por isso a marca é posta no único lugar que
// autentica por token (`exigirSessaoOuToken`), e não espalhada pelos handlers.
func comToken(ctx context.Context) context.Context {
	return context.WithValue(ctx, chaveToken, true)
}

func porTokenDe(ctx context.Context) bool {
	v, _ := ctx.Value(chaveToken).(bool)
	return v
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
		// Conta que o admin negou DEPOIS de ela ter entrado (é assim que se
		// suspende alguém). O cookie é sem estado e continuaria valendo até
		// vencer; é esta linha que faz a decisão valer no pedido seguinte.
		if user.Status != auth.StatusAprovada {
			s.limparCookie(w)
			escreverErro(w, http.StatusUnauthorized, "sessão expirada")
			return
		}
		next.ServeHTTP(w, r.WithContext(comUsuario(r.Context(), user)))
	})
}

// exigirEnvio recusa com 403 a conta que não pode entrar com faixa nova
// (`users.pode_enviar`, migração 0011).
//
// Vem DEPOIS de `exigirSessaoOuToken`, e vale para os dois caminhos: pelo token
// do bot o usuário no contexto é o dono configurado em `INGEST_USER_EMAIL`, e é
// o direito dele que conta.
//
// 403 e nunca 401: o cliente trata 401 como sessão morta e manda a pessoa de
// volta ao login, e aqui a sessão está perfeita — o que falta é permissão.
func (s *Server) exigirEnvio(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !usuarioDe(r.Context()).PodeEnviar {
			escreverErro(w, http.StatusForbidden, "envio de arquivos não liberado para esta conta")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// confereToken compara um token com o SHA-256 (em hex) que a configuração
// guarda. É a conferência dos dois tokens de máquina, o do bot e o do admin.
func confereToken(token, somaHex string) error {
	soma := sha256.Sum256([]byte(token))
	esperado, err := hex.DecodeString(strings.TrimSpace(somaHex))
	if err != nil || len(esperado) != len(soma) {
		return errors.New("soma do token malformada na configuração")
	}
	// Comparação em tempo constante: com `==` o tempo de resposta entrega o
	// prefixo correto byte a byte.
	if subtle.ConstantTimeCompare(soma[:], esperado) != 1 {
		return errors.New("token não confere")
	}
	return nil
}
