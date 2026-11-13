// Package config concentra a configuração da API, lida só de variáveis de
// ambiente — o mesmo padrão (envconfig) das outras APIs do homelab.
package config

import (
	"fmt"
	"strings"

	"github.com/kelseyhightower/envconfig"
)

type Config struct {
	AppEnv string `envconfig:"APP_ENV" default:"production"`
	Port   int    `envconfig:"PORT" default:"8080"`

	DatabaseURL string `envconfig:"DATABASE_URL" required:"true"`

	// Segredo do cookie de sessão. Trocar invalida todas as sessões de uma vez
	// — é o botão de pânico documentado na ADR.
	SessionSecret   string `envconfig:"SESSION_SECRET" required:"true"`
	SessionMaxAgeS  int    `envconfig:"SESSION_MAX_AGE_S" default:"2592000"`
	SessionCookie   string `envconfig:"SESSION_COOKIE" default:"ondas_session"`
	SessionInsecure bool   `envconfig:"SESSION_INSECURE" default:"false"`

	// A plataforma aceita PEDIDOS de conta? Com `false` (o padrão) só quem já
	// tem conta entra.
	//
	// Desde a migração 0011, aberto não quer mais dizer "cria e entra": o
	// pedido nasce em análise e espera o admin (`/api/admin`, `ondasctl`).
	SignupOpen bool `envconfig:"SIGNUP_OPEN" default:"false"`
	// Estes e-mails pulam a análise: a conta nasce aprovada e já entra, com o
	// cadastro aberto ou fechado. É a decisão do admin tomada de antemão.
	SignupAllowlist string `envconfig:"SIGNUP_ALLOWLIST"`

	// Token do ADMIN, guardado como SHA-256 do valor real, pelo mesmo motivo
	// do `INGEST_TOKEN_SHA256` abaixo: a API só precisa conferir.
	//
	// É outro token, e não o do bot com mais poder, de propósito. O do bot mora
	// num node que baixa mídia da internet; o do admin decide quem entra na
	// plataforma. Um vazando não pode levar o outro junto.
	//
	// Vazio (o padrão) = as rotas de `/api/admin` não existem (404).
	AdminTokenSHA256 string `envconfig:"ADMIN_TOKEN_SHA256"`

	// Tentativas de login por IP numa janela, antes de começar a recusar.
	// Fica aqui e não no Traefik porque o Traefik não enxerga o IP real
	// (hostPort mascara), então o rate-limit dele é global, não por cliente.
	LoginAttempts int `envconfig:"LOGIN_ATTEMPTS" default:"8"`
	LoginWindowS  int `envconfig:"LOGIN_WINDOW_S" default:"300"`

	// --- Acervo (fase 2) ---

	// Bucket R2 PRIVADO: sem domínio público, sem r2.dev. Credenciais em
	// secret out-of-git; no git ficam só bucket e TTL (ADR 0011).
	R2AccountID       string `envconfig:"R2_ACCOUNT_ID"`
	R2AccessKeyID     string `envconfig:"R2_ACCESS_KEY_ID"`
	R2SecretAccessKey string `envconfig:"R2_SECRET_ACCESS_KEY"`
	R2Bucket          string `envconfig:"R2_BUCKET" default:"ondas-acervo"`
	// Origem da PWA, usada na política de CORS do bucket.
	OrigemPWA string `envconfig:"ORIGEM_PWA" default:"https://music.thiagotn.com"`
	// Validade da URL assinada. Precisa cobrir a escuta inteira de uma faixa:
	// o navegador segue o 302 uma vez e depois pede os Range direto no R2,
	// com a URL em que caiu. Curto demais quebra o seek de quem pausou.
	R2SignedURLTTLS int `envconfig:"R2_SIGNED_URL_TTL" default:"3600"`

	// Token de máquina do bot do Telegram, guardado como SHA-256 do valor
	// real: a API só precisa verificar, então o segredo em claro não precisa
	// existir no cluster.
	IngestTokenSHA256 string `envconfig:"INGEST_TOKEN_SHA256"`
	// Dono das faixas que entram por token (o bot não tem sessão).
	IngestUserEmail string `envconfig:"INGEST_USER_EMAIL"`
	// E-mails para os quais o TOKEN pode publicar faixa (migração 0007).
	//
	// É o teto do poder novo. Antes da 0007, uma faixa que entrava por token era
	// sempre do `IngestUserEmail` e o token não alcançava conta nenhuma além
	// dela; agora o pedido pode nomear um destino, e sem esta lista o token
	// poderia pôr arquivo em QUALQUER conta cadastrada.
	//
	// Vazio (o padrão) = nenhum destino além do dono, que é exatamente o
	// comportamento anterior. É o que deixa a API nova subir antes do ConfigMap
	// sem mudar nada.
	IngestDestinos string `envconfig:"INGEST_DESTINOS"`

	// Tetos da ingestão. O worker baixa de uma URL arbitrária: sem teto, um
	// arquivo enorme enche o emptyDir e derruba o pod.
	IngestMaxMB    int `envconfig:"INGEST_MAX_MB" default:"60"`
	IngestTimeoutS int `envconfig:"INGEST_TIMEOUT_S" default:"180"`
	WorkerPollS    int `envconfig:"WORKER_POLL_S" default:"5"`
}

// AcervoConfigurado diz se há credencial de R2. Sem ela a API sobe normalmente
// e só o acervo responde 503: um secret ausente não deve derrubar o login.
func (c *Config) AcervoConfigurado() bool {
	return c.R2AccountID != "" && c.R2AccessKeyID != "" && c.R2SecretAccessKey != ""
}

// IngestPorTokenConfigurado diz se o caminho do bot está pronto.
func (c *Config) IngestPorTokenConfigurado() bool {
	return c.IngestTokenSHA256 != "" && c.IngestUserEmail != ""
}

func Load() (*Config, error) {
	var cfg Config
	if err := envconfig.Process("", &cfg); err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	return &cfg, nil
}

// AllowedSignup diz se este e-mail pode pedir conta: ou o cadastro está aberto,
// ou ele está na allowlist.
func (c *Config) AllowedSignup(email string) bool {
	if c.SignupOpen {
		return true
	}
	return naLista(c.SignupAllowlist, email)
}

// SignupSemAnalise diz se a conta deste e-mail nasce aprovada (allowlist).
func (c *Config) SignupSemAnalise(email string) bool {
	return naLista(c.SignupAllowlist, email)
}

// AdminConfigurado diz se há token de admin. Sem ele `/api/admin` responde 404.
func (c *Config) AdminConfigurado() bool {
	return strings.TrimSpace(c.AdminTokenSHA256) != ""
}

// DestinoPermitidoPorToken diz se o token de máquina pode publicar faixa para
// este e-mail.
//
// Só vale para o token. Sessão não passa por aqui: pessoa logada escolhendo
// para quem manda a própria faixa é ato normal, e submetê-la a uma lista do
// ConfigMap seria confundir "limitar um robô" com "limitar gente".
//
// QUEM CHAMA NÃO PODE DIFERENCIAR, NA RESPOSTA, "fora da lista" de "não
// cadastrado": a recusa tem de ser a mesma, senão um token vazado vira
// enumerador de contas — tenta e-mail por e-mail e lê a diferença entre o
// aceite e a recusa.
func (c *Config) DestinoPermitidoPorToken(email string) bool {
	return naLista(c.IngestDestinos, email)
}

// naLista compara e-mail contra uma lista separada por vírgula, sem diferenciar
// maiúsculas — o mesmo critério do índice único de `users` (migração 0001).
func naLista(lista, email string) bool {
	alvo := strings.TrimSpace(strings.ToLower(email))
	if alvo == "" {
		return false
	}
	for _, e := range strings.Split(lista, ",") {
		if e = strings.TrimSpace(strings.ToLower(e)); e != "" && e == alvo {
			return true
		}
	}
	return false
}
