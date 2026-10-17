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
	for _, e := range strings.Split(c.SignupAllowlist, ",") {
		if e = strings.TrimSpace(strings.ToLower(e)); e != "" && e == strings.ToLower(email) {
			return true
		}
	}
	return false
}
