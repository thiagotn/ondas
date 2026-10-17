// Package db abre o pool do Postgres e aplica as migrações embutidas.
package db

import (
	"context"
	"embed"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrations embed.FS

func Open(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("db: url inválida: %w", err)
	}
	// O Postgres é compartilhado com os outros apps do cluster: um pool
	// pequeno evita que o Ondas monopolize conexões por nada.
	cfg.MaxConns = 4
	cfg.MaxConnIdleTime = 5 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("db: pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("db: ping: %w", err)
	}
	return pool, nil
}

// Chave do advisory lock das migrações: arbitrária, mas fixa. Advisory locks
// são globais ao banco, e o banco `ondas` não é compartilhado com outro app.
const chaveLockMigracao int64 = 0x0D5A_0001

// Teto para esperar o lock. Esperar é o certo — o outro pod termina em ~1s —,
// mas sem teto um lock preso penduraria o boot calado para sempre.
const esperaLockMigracao = 30 * time.Second

// Migrate aplica os arquivos de `migrations/` em ordem, uma vez cada.
//
// Roda no start do processo (não num initContainer) porque são poucas, são
// idempotentes e assim não há um segundo lugar para manter em sincronia.
//
// Tudo corre sob um advisory lock porque dois pods sobem juntos em qualquer
// rollout (maxSurge) — e `CREATE TABLE IF NOT EXISTS` NÃO é atômico no
// Postgres: as duas sessões passam pela checagem de existência e uma estoura
// com duplicate key em pg_type. Foi exatamente o que derrubou o primeiro boot
// desta API em produção.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	ctx, cancel := context.WithTimeout(ctx, esperaLockMigracao)
	defer cancel()

	// Uma conexão só, do começo ao fim: o lock é de sessão, então precisa ser
	// a mesma conexão que o pega, usa e devolve.
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("db: conexão para migrar: %w", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, chaveLockMigracao); err != nil {
		return fmt.Errorf("db: lock das migrações: %w", err)
	}
	defer func() {
		// Sem unlock explícito o lock viaja com a conexão de volta para o pool
		// e tranca o próximo boot. WithoutCancel porque o unlock precisa sair
		// mesmo quando é o próprio prazo acima que venceu.
		if _, err := conn.Exec(context.WithoutCancel(ctx),
			`SELECT pg_advisory_unlock($1)`, chaveLockMigracao); err != nil {
			slog.Warn("db: unlock das migrações falhou", "erro", err)
		}
	}()

	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version    text PRIMARY KEY,
		applied_at timestamptz NOT NULL DEFAULT now()
	)`); err != nil {
		return fmt.Errorf("db: tabela de migrações: %w", err)
	}

	arquivos, err := migrations.ReadDir("migrations")
	if err != nil {
		return err
	}
	nomes := make([]string, 0, len(arquivos))
	for _, f := range arquivos {
		nomes = append(nomes, f.Name())
	}
	sort.Strings(nomes)

	for _, nome := range nomes {
		var existe bool
		if err := conn.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1)`, nome,
		).Scan(&existe); err != nil {
			return err
		}
		if existe {
			continue
		}
		sql, err := migrations.ReadFile("migrations/" + nome)
		if err != nil {
			return err
		}
		tx, err := conn.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("db: migração %s: %w", nome, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, nome); err != nil {
			_ = tx.Rollback(ctx)
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		slog.Info("migração aplicada", "version", nome)
	}
	return nil
}
