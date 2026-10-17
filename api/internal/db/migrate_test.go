package db_test

// Regressão da corrida que derrubou o primeiro boot em produção: dois pods
// sobem juntos em qualquer rollout (maxSurge) e `CREATE TABLE IF NOT EXISTS`
// não é atômico no Postgres. Precisa de banco de verdade — o CI sobe um
// serviço `postgres` e passa TEST_DATABASE_URL; sem ele, o teste se declara
// pulado em vez de passar de mentira.

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/thiagotn/ondas/api/internal/db"
	"github.com/thiagotn/ondas/api/internal/dbtest"
)

func TestMigracoesConcorrentesNaoSeAtropelam(t *testing.T) {
	url := dbtest.URL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	// Banco limpo: a corrida só existe quando as tabelas ainda não estão lá.
	limpo, err := db.Open(ctx, url)
	require.NoError(t, err)
	_, err = limpo.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`)
	require.NoError(t, err)
	limpo.Close()

	const n = 6
	largada := make(chan struct{})
	erros := make(chan error, n)
	var wg sync.WaitGroup
	for range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			pool, err := db.Open(ctx, url)
			if err != nil {
				erros <- err
				return
			}
			defer pool.Close()
			<-largada // todos largam juntos, senão não há corrida
			if err := db.Migrate(ctx, pool); err != nil {
				erros <- err
			}
		}()
	}
	time.Sleep(300 * time.Millisecond)
	close(largada)
	wg.Wait()
	close(erros)

	for err := range erros {
		t.Errorf("migração concorrente falhou: %v", err)
	}

	// E aplicou uma vez só, não n vezes.
	pool, err := db.Open(ctx, url)
	require.NoError(t, err)
	defer pool.Close()
	var aplicadas int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM schema_migrations WHERE version = '0001_init.sql'`).Scan(&aplicadas))
	require.Equal(t, 1, aplicadas, "a migração deveria constar uma única vez")

	var temUsers bool
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM information_schema.tables
		   WHERE table_schema = 'public' AND table_name = 'users')`).Scan(&temUsers))
	require.True(t, temUsers, "o schema deveria estar de pé")
}

func TestMigrateIdempotente(t *testing.T) {
	url := dbtest.URL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	pool, err := db.Open(ctx, url)
	require.NoError(t, err)
	defer pool.Close()

	// Rodar de novo no banco já migrado não pode falhar nem duplicar — é o que
	// acontece em todo restart de pod. Também prova que o unlock saiu: sem ele,
	// a segunda chamada ficaria pendurada no lock da primeira.
	require.NoError(t, db.Migrate(ctx, pool))

	contar := func() int {
		var n int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&n))
		return n
	}
	antes := contar()
	require.Positive(t, antes, "deveria haver migração aplicada")

	require.NoError(t, db.Migrate(ctx, pool))
	// A conta não muda — e a asserção não precisa saber quantas migrações
	// existem hoje, senão ela quebra a cada arquivo novo.
	require.Equal(t, antes, contar())
}
