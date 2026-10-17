package db

// Regressão da corrida que derrubou o primeiro boot em produção: dois pods
// sobem juntos em qualquer rollout (maxSurge) e `CREATE TABLE IF NOT EXISTS`
// não é atômico no Postgres. Precisa de banco de verdade — o CI sobe um
// serviço `postgres` e passa TEST_DATABASE_URL; sem ele, o teste se declara
// pulado em vez de passar de mentira.

import (
	"context"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// bancoDeTeste devolve a URL do banco descartável — e se nega a entregar
// qualquer outra: o teste abaixo dá DROP SCHEMA, e uma TEST_DATABASE_URL
// apontada por descuido para o banco real apagaria o acervo. O nome precisa
// terminar em `_test`, o que `ondas` (produção) nunca satisfaz.
func bancoDeTeste(t *testing.T) string {
	t.Helper()
	bruta := os.Getenv("TEST_DATABASE_URL")
	if bruta == "" {
		t.Skip("TEST_DATABASE_URL não definida; teste precisa de Postgres real")
	}
	u, err := url.Parse(bruta)
	require.NoError(t, err, "TEST_DATABASE_URL inválida")
	nome := strings.TrimPrefix(u.Path, "/")
	require.True(t, strings.HasSuffix(nome, "_test"),
		"recusando rodar: estes testes apagam o schema, então o banco precisa "+
			"terminar em `_test` (recebi %q)", nome)
	return bruta
}

func TestMigracoesConcorrentesNaoSeAtropelam(t *testing.T) {
	url := bancoDeTeste(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	// Banco limpo: a corrida só existe quando as tabelas ainda não estão lá.
	limpo, err := Open(ctx, url)
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
			pool, err := Open(ctx, url)
			if err != nil {
				erros <- err
				return
			}
			defer pool.Close()
			<-largada // todos largam juntos, senão não há corrida
			if err := Migrate(ctx, pool); err != nil {
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
	pool, err := Open(ctx, url)
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
	url := bancoDeTeste(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	pool, err := Open(ctx, url)
	require.NoError(t, err)
	defer pool.Close()

	// Rodar de novo no banco já migrado não pode falhar nem duplicar — é o que
	// acontece em todo restart de pod. Também prova que o unlock saiu: sem ele,
	// a segunda chamada ficaria pendurada no lock da primeira.
	require.NoError(t, Migrate(ctx, pool))
	require.NoError(t, Migrate(ctx, pool))

	var linhas int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&linhas))
	require.Equal(t, 1, linhas)
}
