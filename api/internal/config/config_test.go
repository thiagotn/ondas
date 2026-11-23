package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// As regras de cadastro e de destino do bot saíram daqui na migração 0012: são
// dado do banco, testado em `internal/admin` e `internal/httpapi`. O que sobrou
// neste pacote é ler o ambiente.
func TestAdminSoExisteComASomaDoToken(t *testing.T) {
	assert.False(t, (&Config{}).AdminConfigurado())
	assert.False(t, (&Config{AdminTokenSHA256: "   "}).AdminConfigurado(), "só espaço não é token")
	assert.True(t, (&Config{AdminTokenSHA256: "abc"}).AdminConfigurado())
}
