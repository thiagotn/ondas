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

// Migrate aplica os arquivos de `migrations/` em ordem, uma vez cada.
//
// Roda no start do processo (não num initContainer) porque são poucas, são
// idempotentes e assim não há um segundo lugar para manter em sincronia.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version    text PRIMARY KEY,
		applied_at timestamptz NOT NULL DEFAULT now()
	)`)
	if err != nil {
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
		if err := pool.QueryRow(ctx,
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
		tx, err := pool.Begin(ctx)
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
