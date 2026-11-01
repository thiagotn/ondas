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

	// Cadastro aberto? Com `false`, só quem já tem conta entra — o padrão,
	// porque o acervo é pessoal.
	SignupOpen bool `envconfig:"SIGNUP_OPEN" default:"false"`
	// Quando o cadastro está fechado, estes e-mails ainda podem se cadastrar.
	SignupAllowlist string `envconfig:"SIGNUP_ALLOWLIST"`

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

// AllowedSignup diz se este e-mail pode criar conta com o cadastro fechado.
func (c *Config) AllowedSignup(email string) bool {
	if c.SignupOpen {
		return true
	}
	return naLista(c.SignupAllowlist, email)
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
