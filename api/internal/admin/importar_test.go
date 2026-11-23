package admin_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/thiagotn/ondas/api/internal/admin"
	"github.com/thiagotn/ondas/api/internal/dbtest"
)

func TestListaIgnoraCaixaEspacoERepeticao(t *testing.T) {
	require.Equal(t, []string{"a@exemplo.test", "b@exemplo.test"},
		admin.Lista(" A@exemplo.test , b@exemplo.test,,a@EXEMPLO.test "))
	require.Empty(t, admin.Lista(""))
}

// A importação é o que deixa o deploy da 0012 não mudar nada para ninguém.
func TestImportarEnvLevaOConfigMapParaOBanco(t *testing.T) {
	pool := dbtest.Pool(t)
	ctx := context.Background()
	p := admin.New(pool)
	comConta := dbtest.CriarUsuario(t, pool, "comconta@exemplo.test")
	semMarca := dbtest.CriarUsuario(t, pool, "semmarca@exemplo.test")

	importou, err := admin.ImportarEnv(ctx, pool, admin.DoEnv{
		CadastroAberto: true,
		// Uma com conta (não vira convite) e duas sem.
		Allowlist: "ComConta@exemplo.test, convidada@exemplo.test, outra@exemplo.test",
		// Com conta; convidada; e uma que não tem conta nem convite.
		Destinos: "comconta@exemplo.test,convidada@exemplo.test,ninguem@exemplo.test",
	})
	require.NoError(t, err)
	require.True(t, importou)

	aberto, err := p.CadastroAberto(ctx)
	require.NoError(t, err)
	require.True(t, aberto)

	convites, err := p.Convites(ctx)
	require.NoError(t, err)
	porEmail := map[string]admin.Convite{}
	for _, c := range convites {
		porEmail[c.Email] = c
	}
	require.Len(t, porEmail, 2, "quem já tem conta não vira convite; destino sem convite não cria um")
	require.True(t, porEmail["convidada@exemplo.test"].RecebeDoBot, "a marca espera no convite")
	require.False(t, porEmail["outra@exemplo.test"].RecebeDoBot)
	require.False(t, porEmail["convidada@exemplo.test"].PodeEnviar, "a allowlist nunca deu envio")

	c, err := p.Conta(ctx, comConta)
	require.NoError(t, err)
	require.True(t, c.RecebeDoBot)
	c, err = p.Conta(ctx, semMarca)
	require.NoError(t, err)
	require.False(t, c.RecebeDoBot, "quem não estava em INGEST_DESTINOS continua fora")
}

// Da segunda subida em diante o env é ignorado — inclusive quando ele diz o
// contrário do que o admin já decidiu na tela.
func TestImportarEnvSoAconteceUmaVez(t *testing.T) {
	pool := dbtest.Pool(t)
	ctx := context.Background()
	p := admin.New(pool)

	importou, err := admin.ImportarEnv(ctx, pool, admin.DoEnv{CadastroAberto: true})
	require.NoError(t, err)
	require.True(t, importou)

	require.NoError(t, p.DefinirCadastroAberto(ctx, false))

	importou, err = admin.ImportarEnv(ctx, pool, admin.DoEnv{
		CadastroAberto: true, Allowlist: "tarde@exemplo.test",
	})
	require.NoError(t, err)
	require.False(t, importou)

	aberto, err := p.CadastroAberto(ctx)
	require.NoError(t, err)
	require.False(t, aberto, "a decisão do admin vale mais que o env")
	convites, err := p.Convites(ctx)
	require.NoError(t, err)
	require.Empty(t, convites)
}
