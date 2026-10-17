package auth

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHashEVerificaSenha(t *testing.T) {
	hash, err := HashPassword("correcthorsebattery")
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(hash, "$argon2id$"), "guarda os parâmetros no formato PHC")
	assert.True(t, VerifyPassword(hash, "correcthorsebattery"))
	assert.False(t, VerifyPassword(hash, "correcthorsebatterZ"))
}

func TestHashNuncaSeRepete(t *testing.T) {
	a, err := HashPassword("mesma-senha")
	require.NoError(t, err)
	b, err := HashPassword("mesma-senha")
	require.NoError(t, err)
	// Salt aleatório: dois hashes iguais entregariam que as senhas são iguais.
	assert.NotEqual(t, a, b)
	assert.True(t, VerifyPassword(a, "mesma-senha"))
	assert.True(t, VerifyPassword(b, "mesma-senha"))
}

func TestHashMalformadoNaoAutentica(t *testing.T) {
	for _, hash := range []string{
		"", "nao-e-hash", "$argon2id$v=19$m=65536,t=1,p=4$sal$",
		"$bcrypt$v=19$m=65536,t=1,p=4$c2FsdA$aGFzaA",
		"$argon2id$v=1$m=65536,t=1,p=4$c2FsdA$aGFzaA",
	} {
		assert.False(t, VerifyPassword(hash, "qualquer"), "hash %q", hash)
	}
}

func TestHashComParametroZeradoNaoDerrubaOProcesso(t *testing.T) {
	// Regressão: `argon2.IDKey` entra em panic com keyLen/p/m zerados, e esses
	// valores chegam de um hash truncado — ou seja, de dado, não de código.
	for _, hash := range []string{
		"$argon2id$v=19$m=65536,t=1,p=4$c2FsdHNhbHQ$",
		"$argon2id$v=19$m=65536,t=0,p=4$c2FsdHNhbHQ$aGFzaGhhc2g",
		"$argon2id$v=19$m=65536,t=1,p=0$c2FsdHNhbHQ$aGFzaGhhc2g",
		"$argon2id$v=19$m=1,t=1,p=4$c2FsdHNhbHQ$aGFzaGhhc2g",
		"$argon2id$v=19$m=65536,t=1,p=4$$aGFzaGhhc2g",
	} {
		assert.NotPanics(t, func() { VerifyPassword(hash, "qualquer") }, "hash %q", hash)
		assert.False(t, VerifyPassword(hash, "qualquer"))
	}
}
