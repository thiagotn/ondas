package auth

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSessaoIdaEVolta(t *testing.T) {
	s := NewSessions("segredo-de-teste", time.Hour)
	cookie := s.Sign("11111111-2222-3333-4444-555555555555")
	id, err := s.Verify(cookie)
	require.NoError(t, err)
	assert.Equal(t, "11111111-2222-3333-4444-555555555555", id)
}

func TestSessaoAdulteradaNaoPassa(t *testing.T) {
	s := NewSessions("segredo-de-teste", time.Hour)
	cookie := s.Sign("usuario-1")

	// Trocar o corpo sem refazer o MAC é a tentativa óbvia de virar outro
	// usuário — tem de falhar.
	forjado := NewSessions("outro-segredo", time.Hour).Sign("usuario-2")
	_, err := s.Verify(forjado)
	assert.ErrorIs(t, err, ErrSessaoInvalida)

	for _, ruim := range []string{
		cookie[:len(cookie)-1] + "X",
		"v2" + cookie[2:],
		"sem-pontos",
		"v1.corpo.mac",
	} {
		_, err := s.Verify(ruim)
		assert.Error(t, err, "cookie %q", ruim)
	}
}

func TestSessaoExpira(t *testing.T) {
	s := NewSessions("segredo-de-teste", time.Hour)
	agora := time.Now()
	s.agora = func() time.Time { return agora }
	cookie := s.Sign("usuario-1")

	s.agora = func() time.Time { return agora.Add(59 * time.Minute) }
	_, err := s.Verify(cookie)
	require.NoError(t, err)

	s.agora = func() time.Time { return agora.Add(time.Hour + time.Second) }
	_, err = s.Verify(cookie)
	assert.ErrorIs(t, err, ErrSessaoExpirada)
}

func TestSessaoComIDContendoPonto(t *testing.T) {
	// O separador é o ÚLTIMO ponto; um id com ponto no meio não pode quebrar
	// a leitura da expiração.
	s := NewSessions("segredo", time.Hour)
	id, err := s.Verify(s.Sign("conta.com.ponto"))
	require.NoError(t, err)
	assert.Equal(t, "conta.com.ponto", id)
}
