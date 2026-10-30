package db_test

// O congelamento do padrão de `users.publico`, feito pela migração 0005.
//
// O teste é ESCRITO AO CONTRÁRIO — desfaz a 0005 e a roda de novo — porque
// `dbtest.Pool` entrega o banco já migrado até a cabeça (`dbtest.go`), e não
// existe jeito de aplicar migração parcial. Sem o desfazer não haveria
// instante em que a coluna está nula para o backfill decidir, e o teste viraria
// uma paráfrase do SQL em vez do SQL embutido de verdade.

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/thiagotn/ondas/api/internal/acervo"
	"github.com/thiagotn/ondas/api/internal/db"
	"github.com/thiagotn/ondas/api/internal/dbtest"
)

func TestPadraoDoPublicoCongelaNaMigracao(t *testing.T) {
	pool := dbtest.Pool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	_, err := pool.Exec(ctx, `ALTER TABLE users DROP COLUMN publico`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx,
		`DELETE FROM schema_migrations WHERE version = '0005_publico.sql'`)
	require.NoError(t, err)

	// Uma conta com acervo e uma vazia, as duas anteriores à coluna.
	comAcervo := dbtest.CriarUsuario(t, pool, "tem@exemplo.test")
	vazia := dbtest.CriarUsuario(t, pool, "nao-tem@exemplo.test")
	_, err = acervo.NewTracks(pool).Criar(ctx, acervo.Nova{
		ID: "44444444-4444-4444-8444-444444444444", UserID: comAcervo,
		Title: "minha", Artist: "a", Genre: "acervo", DurS: 10,
		AudioKey: "u/tem/a/1.mp3", AudioType: "audio/mpeg", SizeBytes: 1,
	})
	require.NoError(t, err)

	require.NoError(t, db.Migrate(ctx, pool))

	publicoDe := func(id string) bool {
		var v bool
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT publico FROM users WHERE id = $1`, id).Scan(&v))
		return v
	}
	require.False(t, publicoDe(comAcervo),
		"quem já tem faixa no acervo abre nele, sem o catálogo público")
	require.True(t, publicoDe(vazia),
		"conta vazia abre com o catálogo público, que é a única fonte que ela tem")

	// E cadastro novo nasce ligado: a `DEFAULT true` tem de valer DEPOIS do
	// backfill. Se alguém juntar o ADD COLUMN e o DEFAULT num comando só, o
	// teste acima quebra; este garante que a correção não seja tirar o padrão.
	nova := dbtest.CriarUsuario(t, pool, "nova@exemplo.test")
	require.True(t, publicoDe(nova), "conta nova não tem faixa, então nasce ligada")
}
