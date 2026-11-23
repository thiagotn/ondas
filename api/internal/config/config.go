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

	// LEGADO, lido UMA vez. Desde a migração 0012 quem decide se o cadastro
	// está aberto e quais e-mails pulam a análise é o banco (`config` e
	// `convites`, geridos pelo painel de admin). Estes dois só existem para
	// `admin.ImportarEnv` levar para lá, na primeira subida, o que o ConfigMap
	// dizia; depois disso são ignorados e podem sair do cluster.
	SignupOpen      bool   `envconfig:"SIGNUP_OPEN" default:"false"`
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
	// LEGADO, lido UMA vez, como `SIGNUP_ALLOWLIST` acima: para quais contas o
	// TOKEN pode publicar faixa. Desde a migração 0012 é a coluna
	// `users.recebe_do_bot`, que o painel de admin liga conta por conta.
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

// AdminConfigurado diz se há token de admin. Sem ele `/api/admin` responde 404.
func (c *Config) AdminConfigurado() bool {
	return strings.TrimSpace(c.AdminTokenSHA256) != ""
}
