package auth

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestLimitadorBloqueiaEDepoisLibera(t *testing.T) {
	l := NewLimiter(3, time.Minute)
	agora := time.Now()
	l.agora = func() time.Time { return agora }

	for i := 0; i < 3; i++ {
		assert.True(t, l.Permitido("1.2.3.4"), "tentativa %d", i+1)
	}
	assert.False(t, l.Permitido("1.2.3.4"), "a 4ª na janela é recusada")
	assert.True(t, l.Permitido("9.9.9.9"), "outro cliente não é afetado")

	agora = agora.Add(61 * time.Second)
	assert.True(t, l.Permitido("1.2.3.4"), "passada a janela, volta a tentar")
}

func TestLoginBemSucedidoLimpaOContador(t *testing.T) {
	l := NewLimiter(2, time.Minute)
	assert.True(t, l.Permitido("1.2.3.4"))
	assert.True(t, l.Permitido("1.2.3.4"))
	assert.False(t, l.Permitido("1.2.3.4"))
	l.Esquecer("1.2.3.4")
	assert.True(t, l.Permitido("1.2.3.4"))
}
