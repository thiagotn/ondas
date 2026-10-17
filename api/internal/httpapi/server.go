package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/thiagotn/ondas/api/internal/acervo"
	"github.com/thiagotn/ondas/api/internal/auth"
	"github.com/thiagotn/ondas/api/internal/config"
	"github.com/thiagotn/ondas/api/internal/storage"
)

type Server struct {
	cfg      *config.Config
	pool     *pgxpool.Pool
	users    *auth.Users
	sessions *auth.Sessions
	limiter  *auth.Limiter
	tracks   *acervo.Tracks
	jobs     *acervo.Jobs
	// nil quando não há credencial de R2: o acervo responde 503 e o login
	// segue funcionando.
	r2 *storage.R2
}

func New(cfg *config.Config, pool *pgxpool.Pool) *Server {
	s := &Server{
		cfg:      cfg,
		pool:     pool,
		users:    auth.NewUsers(pool),
		sessions: auth.NewSessions(cfg.SessionSecret, time.Duration(cfg.SessionMaxAgeS)*time.Second),
		limiter:  auth.NewLimiter(cfg.LoginAttempts, time.Duration(cfg.LoginWindowS)*time.Second),
		tracks:   acervo.NewTracks(pool),
		jobs:     acervo.NewJobs(pool),
	}
	if !cfg.AcervoConfigurado() {
		slog.Warn("acervo desligado: sem credencial de R2 (R2_ACCOUNT_ID/KEY/SECRET)")
		return s
	}
	r2, err := storage.New(cfg.R2AccountID, cfg.R2AccessKeyID, cfg.R2SecretAccessKey,
		cfg.R2Bucket, time.Duration(cfg.R2SignedURLTTLS)*time.Second)
	if err != nil {
		// Credencial presente mas inválida é erro de configuração, não motivo
		// para derrubar o login de quem já tem conta.
		slog.Error("acervo desligado: R2 inválido", "erro", err)
		return s
	}
	s.r2 = r2
	return s
}

// Router monta as rotas sob `/api`. Não há CORS: a API é servida na mesma
// origem da PWA (um path a mais no Ingress), o que também evita preflight.
func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(chiMiddleware.RealIP)
	r.Use(chiMiddleware.Recoverer)

	r.Route("/api", func(r chi.Router) {
		r.Get("/healthz", s.healthz)
		r.Get("/readyz", s.readyz)

		r.Route("/auth", func(r chi.Router) {
			r.Post("/signup", s.signup)
			r.Post("/login", s.login)
			r.Post("/logout", s.logout)
			r.With(s.exigirSessao).Get("/me", s.me)
		})

		// Nada aqui é público: o acervo é privado por definição.
		r.Route("/acervo", func(r chi.Router) {
			r.Use(s.exigirAcervo)

			// A ingestão aceita os dois chamadores: a PWA pelo cookie e o bot
			// do Telegram pelo X-Ondas-Token.
			r.With(s.exigirSessaoOuToken).Post("/ingest", s.ingerir)
			r.With(s.exigirSessaoOuToken).Get("/ingest/{id}", s.statusIngestao)

			r.Group(func(r chi.Router) {
				r.Use(s.exigirSessao)
				r.Get("/", s.listarAcervo)
				r.Get("/{id}/audio", s.audio)
				r.Get("/{id}/art", s.arte)
				r.Delete("/{id}", s.removerFaixa)
			})
		})
	})
	return r
}

func (s *Server) healthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte("ok\n"))
}

// readyz confere o banco; o healthz fica de fora disso de propósito, para o
// kubelet não matar o pod por uma indisponibilidade momentânea do Postgres.
func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.pool.Ping(ctx); err != nil {
		escreverErro(w, http.StatusServiceUnavailable, "banco indisponível")
		return
	}
	escreverJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) signup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	if !s.cfg.AllowedSignup(req.Email) {
		escreverErro(w, http.StatusForbidden, "cadastro fechado")
		return
	}
	user, err := s.users.Create(r.Context(), req.Email, req.Password)
	switch {
	case errors.Is(err, auth.ErrEmailInvalido), errors.Is(err, auth.ErrSenhaCurta):
		escreverErro(w, http.StatusBadRequest, err.Error())
		return
	case errors.Is(err, auth.ErrEmailEmUso):
		escreverErro(w, http.StatusConflict, err.Error())
		return
	case err != nil:
		slog.Error("signup", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível criar a conta")
		return
	}
	s.gravarCookie(w, user.ID)
	escreverJSON(w, http.StatusCreated, user)
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	ip := clienteIP(r)
	if !s.limiter.Permitido(ip) {
		slog.Warn("login bloqueado por tentativas", "ip", ip)
		escreverErro(w, http.StatusTooManyRequests, "muitas tentativas — espere alguns minutos")
		return
	}
	user, err := s.users.Authenticate(r.Context(), req.Email, req.Password)
	if err != nil {
		if !errors.Is(err, auth.ErrSenhaInvalida) {
			slog.Error("login", "erro", err)
		} else {
			slog.Info("login recusado", "ip", ip)
		}
		escreverErro(w, http.StatusUnauthorized, auth.ErrSenhaInvalida.Error())
		return
	}
	s.limiter.Esquecer(ip)
	s.gravarCookie(w, user.ID)
	escreverJSON(w, http.StatusOK, user)
}

func (s *Server) logout(w http.ResponseWriter, _ *http.Request) {
	s.limparCookie(w)
	escreverJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	escreverJSON(w, http.StatusOK, usuarioDe(r.Context()))
}

func (s *Server) gravarCookie(w http.ResponseWriter, userID string) {
	http.SetCookie(w, &http.Cookie{
		Name:  s.cfg.SessionCookie,
		Value: s.sessions.Sign(userID),
		Path:  "/",
		// HttpOnly tira o cookie do alcance de qualquer script; SameSite=Lax
		// basta porque a PWA e a API dividem a origem. Secure sai só em dev
		// (http://localhost), senão o navegador descarta o cookie.
		HttpOnly: true,
		Secure:   !s.cfg.SessionInsecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(s.sessions.MaxAge().Seconds()),
	})
}

func (s *Server) limparCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     s.cfg.SessionCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   !s.cfg.SessionInsecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}
