package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestCadastroFechadoRespeitaALista(t *testing.T) {
	cfg := &Config{SignupOpen: false, SignupAllowlist: " Thiago@exemplo.com , outro@exemplo.com "}
	assert.True(t, cfg.AllowedSignup("thiago@exemplo.com"), "a comparação ignora caixa e espaços")
	assert.True(t, cfg.AllowedSignup("outro@exemplo.com"))
	assert.False(t, cfg.AllowedSignup("estranho@exemplo.com"))
}

func TestCadastroAbertoAceitaQualquerUm(t *testing.T) {
	cfg := &Config{SignupOpen: true}
	assert.True(t, cfg.AllowedSignup("qualquer@exemplo.com"))
}

func TestListaVaziaNaoLiberaNinguem(t *testing.T) {
	cfg := &Config{}
	assert.False(t, cfg.AllowedSignup(""))
	assert.False(t, cfg.AllowedSignup("alguem@exemplo.com"))
}
