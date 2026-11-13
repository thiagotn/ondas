package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"time"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/thiagotn/ondas/api/internal/acervo"
	"github.com/thiagotn/ondas/api/internal/audius"
	"github.com/thiagotn/ondas/api/internal/auth"
	"github.com/thiagotn/ondas/api/internal/config"
	"github.com/thiagotn/ondas/api/internal/history"
	"github.com/thiagotn/ondas/api/internal/likes"
	"github.com/thiagotn/ondas/api/internal/playlists"
	"github.com/thiagotn/ondas/api/internal/storage"
)

type Server struct {
	cfg      *config.Config
	pool     *pgxpool.Pool
	users    *auth.Users
	sessions *auth.Sessions
	limiter  *auth.Limiter
	// Freios próprios, para um não gastar a cota do outro: pedidos de conta
	// por IP, senha errada numa ação de conta (por conta), e token de admin
	// errado por IP.
	cadastroLimiter *auth.Limiter
	senhaLimiter    *auth.Limiter
	adminLimiter    *auth.Limiter
	tracks          *acervo.Tracks
	jobs            *acervo.Jobs
	likes           *likes.Likes
	// As playlists da conta. Como as curtidas, não dependem de R2 nenhum.
	playlists *playlists.Playlists
	// O marcador (onde a conta parou) e o histórico do que ela ouviu.
	history *history.History
	// Prévia de link: cliente do Audius com cache, e um freio próprio — é a
	// única rota pública que faz chamada para fora.
	audius    *audius.Client
	ogLimiter *auth.Limiter
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
		// O cadastro é a única rota pública que GRAVA, e cada pedido custa um
		// argon2: dez por hora por IP sobra para uma casa inteira pedir conta,
		// e não sobra para encher a fila do admin.
		cadastroLimiter: auth.NewLimiter(10, time.Hour),
		senhaLimiter:    auth.NewLimiter(cfg.LoginAttempts, time.Duration(cfg.LoginWindowS)*time.Second),
		adminLimiter:    auth.NewLimiter(cfg.LoginAttempts, time.Duration(cfg.LoginWindowS)*time.Second),
		tracks:          acervo.NewTracks(pool),
		jobs:            acervo.NewJobs(pool),
		likes:           likes.NewLikes(pool),
		playlists:       playlists.NewPlaylists(pool),
		history:         history.NewHistory(pool),
		audius:          audius.New(audius.Opcoes{}),
		ogLimiter:       auth.NewLimiter(60, time.Minute),
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

		// Prévia de link, pública de propósito: quem chama é o robô do
		// WhatsApp/Telegram, que não tem cookie. Fica FORA dos grupos do
		// acervo — e para faixa do acervo ela não diz nada (ver og.go).
		r.Get("/og/t/{seg}", s.ogFaixa)

		r.Route("/auth", func(r chi.Router) {
			r.Post("/signup", s.signup)
			r.Post("/login", s.login)
			r.Post("/logout", s.logout)
			r.With(s.exigirSessao).Get("/me", s.me)

			// Preferência de conta: sessão, NUNCA token.
			//
			// É a mesma régua que divide os dois grupos do acervo abaixo. O
			// token de máquina do Hermes existe para entrar com faixa nova;
			// desligar o catálogo de alguém não é isso. `exigirSessao` nem
			// olha o header, então o token aqui simplesmente não abre porta.
			r.With(s.exigirSessao).Patch("/prefs", s.prefs)

			// A conta administrando a si mesma: nome, senha, e ir embora.
			// Sessão e NUNCA token, pela régua de sempre — e as duas que não
			// têm volta pedem a senha de novo no corpo (ver conta.go).
			r.With(s.exigirSessao).Patch("/conta", s.renomearConta)
			r.With(s.exigirSessao).Post("/senha", s.trocarSenha)
			r.With(s.exigirSessao).Post("/conta/apagar", s.apagarConta)
		})

		// Administração: quem entra na plataforma e quem pode enviar arquivo.
		//
		// Token próprio (`X-Ondas-Admin-Token`), NUNCA sessão e nunca o token
		// do bot: não existe papel de admin em `users`, então não há cookie que
		// abra esta porta, e a PWA não tem tela para isto. Quem consome é a
		// `ondasctl` (cmd/ondasctl).
		r.Route("/admin", func(r chi.Router) {
			r.Use(s.exigirAdmin)
			r.Get("/contas", s.listarContas)
			r.Post("/contas/{id}/aprovar", s.aprovarConta)
			r.Post("/contas/{id}/negar", s.negarConta)
			r.Patch("/contas/{id}/envio", s.definirEnvio)
		})

		// Curtidas: sessão, NUNCA token, pela mesma régua do PATCH /auth/prefs
		// acima. O token de máquina do Hermes existe para entrar com faixa
		// nova; o gosto de alguém não é isso.
		//
		// Fora do grupo /acervo de propósito: curtida não depende de R2
		// nenhum, e o 503 "acervo não configurado" de `exigirAcervo` seria uma
		// mentira para quem só quer curtir uma faixa do Audius.
		r.Route("/likes", func(r chi.Router) {
			r.Use(s.exigirSessao)
			r.Get("/", s.listarLikes)
			r.Patch("/", s.aplicarLikes)
		})

		// Playlists: a mesma régua das curtidas, e pelos mesmos dois motivos.
		//
		// Sessão, NUNCA token: o token de máquina do Hermes existe para entrar
		// com faixa nova, e organizar a biblioteca de alguém não é isso.
		//
		// E fora do grupo /acervo de propósito: playlist não depende de R2
		// nenhum — ela pode ser feita só de faixa do Audius —, então o 503
		// "acervo não configurado" de `exigirAcervo` seria uma mentira.
		r.Route("/playlists", func(r chi.Router) {
			r.Use(s.exigirSessao)
			r.Get("/", s.listarPlaylists)
			r.Post("/", s.criarPlaylist)
			r.Patch("/{id}", s.renomearPlaylist)
			r.Delete("/{id}", s.apagarPlaylist)
			r.Patch("/{id}/itens", s.aplicarItensDaPlaylist)
		})

		// O marcador e o histórico: a mesma régua das curtidas e das playlists,
		// e pelos mesmos dois motivos — sessão e NUNCA token (o que alguém
		// ouviu não é assunto do bot que traz faixa nova), e fora do grupo
		// /acervo (a maioria do que se ouve é do Audius, e o 503 de
		// `exigirAcervo` seria uma mentira).
		//
		// São dois endereços porque são duas coisas com vidas diferentes (ver
		// a migração 0009): `/playback` é reescrito a cada quinze segundos de
		// música, `/history` cresce uma linha por faixa ouvida.
		r.Route("/playback", func(r chi.Router) {
			r.Use(s.exigirSessao)
			r.Get("/", s.lerMarcador)
			r.Put("/", s.gravarMarcador)
		})
		r.Route("/history", func(r chi.Router) {
			r.Use(s.exigirSessao)
			r.Get("/", s.listarHistorico)
			r.Post("/", s.registrarHistorico)
			r.Delete("/", s.limparHistorico)
		})

		// Nada aqui é público: o acervo é privado por definição.
		//
		// O corte entre os dois grupos abaixo é **entrar com faixa nova** vs.
		// **mexer no acervo que já existe**. Não é um detalhe de arrumação: é
		// onde mora o teto do token de máquina.
		r.Route("/acervo", func(r chi.Router) {
			r.Use(s.exigirAcervo)

			// Entrar com faixa nova: a PWA pelo cookie, e o node do Hermes
			// pelo X-Ondas-Token.
			//
			// O envio de arquivo entrou aqui (antes era só sessão) porque a
			// skill do SoundCloud não tem URL de mídia para mandar: URL do
			// SoundCloud é página, e o worker do cluster não tem scdl. Quem
			// baixa é o node, e aí os bytes só existem no disco dele — a
			// única porta para o acervo é o PUT assinado.
			//
			// Isso não afrouxa a autorização, porque ela nunca esteve no
			// middleware: a key é derivada do usuário AUTENTICADO
			// (`stage/<dono>/<uuid>.bin`), nunca de algo que o pedido mandou.
			// O teto do token continua sendo "não alcança faixa de outra
			// pessoa, não lê e não apaga o acervo" — e nunca foi "não grava
			// objeto no bucket", já que `POST /ingest` sempre pôde pedir ao
			// worker que gravasse uma mídia baixada de qualquer URL.
			r.Group(func(r chi.Router) {
				r.Use(s.exigirSessaoOuToken)
				// `exigirEnvio` nas três que ENTRAM com faixa, e não na
				// consulta de status: quem perdeu o direito de enviar ainda
				// pode saber o fim do que já tinha enviado.
				r.With(s.exigirEnvio).Post("/ingest", s.ingerir)
				r.Get("/ingest/{id}", s.statusIngestao)
				r.With(s.exigirEnvio).Post("/upload", s.pedirVagaDeUpload)
				r.With(s.exigirEnvio).Post("/upload/{id}/finalizar", s.finalizarUpload)
			})

			// Mexer no acervo que já existe: só sessão, nunca token.
			//
			// É aqui que um token vazado viraria exfiltração (listar, baixar)
			// ou destruição (apagar), e não em criar um objeto na própria área
			// de espera. `TestEscopoDoTokenNoAcervo` trava esta divisão: mover
			// uma rota de grupo sem querer compila, e só o teste denuncia.
			//
			// `compartilhamento` entra aqui, e não no grupo de cima, embora o
			// bot também saiba publicar para alguém: o bot escolhe o destino de
			// faixa que ele mesmo está trazendo, e isso é "entrar com faixa
			// nova". Mudar com quem uma faixa JÁ EXISTENTE é dividida é mexer
			// no acervo, e para isso só sessão serve.
			r.Group(func(r chi.Router) {
				r.Use(s.exigirSessao)
				r.Get("/", s.listarAcervo)
				r.Get("/{id}/audio", s.audio)
				r.Get("/{id}/art", s.arte)
				r.Patch("/{id}/compartilhamento", s.compartilhar)
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

// signup recebe um PEDIDO de conta.
//
// Dois desfechos, e o status HTTP é o que os separa:
//
//	202 — o pedido entrou em análise. Sem cookie: a conta existe, mas não entra
//	      até o admin aprovar (`ondasctl contas aprovar`).
//	201 — e-mail da allowlist: a conta nasce aprovada e já sai logada, como era
//	      o cadastro antes da migração 0011.
//
// Em nenhum dos dois a conta nasce podendo enviar arquivo.
func (s *Server) signup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name     string `json:"name"`
		Email    string `json:"email"`
		Password string `json:"password"`
		Mensagem string `json:"mensagem"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	if !s.cfg.AllowedSignup(req.Email) {
		escreverErro(w, http.StatusForbidden, "cadastro fechado")
		return
	}
	ip := clienteIP(r)
	if !s.cadastroLimiter.Permitido(ip) {
		slog.Warn("cadastro bloqueado por tentativas", "ip", ip)
		escreverErro(w, http.StatusTooManyRequests, "muitas tentativas — espere alguns minutos")
		return
	}
	status := auth.StatusPendente
	if s.cfg.SignupSemAnalise(req.Email) {
		status = auth.StatusAprovada
	}
	user, err := s.users.Create(r.Context(), auth.Nova{
		Email: req.Email, Senha: req.Password, Nome: req.Name, Mensagem: req.Mensagem, Status: status,
	})
	switch {
	case errors.Is(err, auth.ErrEmailInvalido), errors.Is(err, auth.ErrNomeInvalido):
		escreverErro(w, http.StatusBadRequest, err.Error())
		return
	case errors.Is(err, auth.ErrMensagemLonga):
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return
	case errors.Is(err, auth.ErrSenhaCurta):
		// O mínimo vai separado: em en e es ele não cai no mesmo ponto da frase.
		escreverErroCod(w, http.StatusBadRequest, CodSenhaCurta, err.Error(),
			map[string]any{"minimo": auth.SenhaMinima})
		return
	case errors.Is(err, auth.ErrEmailEmUso):
		escreverErro(w, http.StatusConflict, err.Error())
		return
	case err != nil:
		slog.Error("signup", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível criar a conta")
		return
	}
	if status == auth.StatusPendente {
		slog.Info("pedido de conta", "conta", user.ID, "ip", ip)
		escreverJSON(w, http.StatusAccepted, map[string]string{"status": auth.StatusPendente})
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
	// O estado do pedido só é dito a quem ACERTOU a senha: é assim que a pessoa
	// fica sabendo da decisão (a plataforma não manda e-mail), sem que a
	// resposta vire um oráculo de quem pediu conta. Para qualquer outro, e-mail
	// em análise e e-mail inexistente dão o mesmo "credenciais inválidas".
	//
	// 403 e não 401: o cliente lê 401 como sessão morta.
	switch user.Status {
	case auth.StatusAprovada:
	case auth.StatusPendente:
		escreverErro(w, http.StatusForbidden, "conta em análise")
		return
	default:
		escreverErro(w, http.StatusForbidden, "cadastro negado")
		return
	}
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

// prefs muda as preferências da conta: `publico` e a aparência (`prefs`: tema,
// idioma e os ajustes do fundo).
//
// Os campos são PONTEIROS de propósito: com `bool`, um corpo sem a chave
// decodificaria para `false` e desligaria o catálogo de quem só queria mandar
// um JSON errado. Ausente é "não mexa" — e um pedido que não mexe em nada é
// inválido, não um 200 que finge ter feito algo.
func (s *Server) prefs(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Publico *bool       `json:"publico"`
		Prefs   *auth.Prefs `json:"prefs"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	var aparencia auth.Prefs
	if req.Prefs != nil {
		aparencia = *req.Prefs
	}
	if (req.Publico == nil && aparencia.Vazio()) || !validarPrefs(aparencia) {
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return
	}
	user, err := s.users.AtualizarPrefs(r.Context(), usuarioDe(r.Context()).ID, req.Publico, aparencia)
	if err != nil {
		// Conta apagada com cookie válido na mão: o mesmo tratamento do
		// middleware, para o cliente cair no fluxo de sessão morta.
		if errors.Is(err, auth.ErrNaoEncontrado) {
			s.limparCookie(w)
			escreverErro(w, http.StatusUnauthorized, "sessão expirada")
			return
		}
		slog.Error("prefs", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível salvar a preferência")
		return
	}
	escreverJSON(w, http.StatusOK, user)
}

// A FORMA de um id de tema e de uma tag de idioma. Só a forma: quais existem é
// assunto do cliente (`themes.ts` e `LOCALES`, no core), e uma lista aqui seria
// a terceira cópia — tema novo passaria a exigir deploy da API antes de poder
// ser salvo. O que esta peneira impede é texto arbitrário virar coluna.
var (
	reTema   = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)
	reIdioma = regexp.MustCompile(`^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$`)
)

// validarPrefs confere os campos que vieram; `nil` passa, porque é "não mexa".
//
// Fora da faixa é pedido inválido, e NÃO é ajustado para a borda: um cliente
// que manda opacidade 5 tem um bug, e gravar 1 em silêncio o esconderia. As
// faixas são as dos sliders (`OPACITY_MIN`/`OPACITY_MAX`/`BLUR_MAX` no core) e
// as dos CHECKs da migração 0010 — que só pegariam o erro como um 500.
//
// `blur` fracionário nem chega aqui: o campo é inteiro, e `12.5` já falha no
// `lerJSON`.
func validarPrefs(p auth.Prefs) bool {
	if p.Tema != nil && !reTema.MatchString(*p.Tema) {
		return false
	}
	if p.Idioma != nil && !reIdioma.MatchString(*p.Idioma) {
		return false
	}
	if p.Opacity != nil && !(*p.Opacity >= 0.3 && *p.Opacity <= 1) {
		return false
	}
	if p.Blur != nil && (*p.Blur < 0 || *p.Blur > 40) {
		return false
	}
	if p.Wall != nil && *p.Wall != "capa" && *p.Wall != "imagem" && *p.Wall != "nenhum" {
		return false
	}
	return true
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
