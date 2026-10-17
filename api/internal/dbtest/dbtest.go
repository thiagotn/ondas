// Package dbtest empresta aos testes um Postgres de verdade.
//
// Existe porque as partes mais fáceis de errar do acervo — fila com SKIP
// LOCKED, índice parcial de unicidade, recorte por usuário — só se provam
// contra um banco real; com um repositório de mentira o teste passaria
// descrevendo o que eu acho que o SQL faz.
package dbtest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/thiagotn/ondas/api/internal/db"
)

// URL devolve a URL do banco descartável — e recusa qualquer outra.
//
// Os testes criam e apagam schemas. Uma TEST_DATABASE_URL apontada por
// descuido para o banco real mexeria no acervo, então o nome tem de terminar
// em `_test`, o que `ondas` (produção) nunca satisfaz.
func URL(t *testing.T) string {
	t.Helper()
	bruta := os.Getenv("TEST_DATABASE_URL")
	if bruta == "" {
		t.Skip("TEST_DATABASE_URL não definida; teste precisa de Postgres real")
	}
	u, err := url.Parse(bruta)
	if err != nil {
		t.Fatalf("TEST_DATABASE_URL inválida: %v", err)
	}
	nome := strings.TrimPrefix(u.Path, "/")
	if !strings.HasSuffix(nome, "_test") {
		t.Fatalf("recusando rodar: estes testes apagam dados, então o banco "+
			"precisa terminar em `_test` (recebi %q)", nome)
	}
	return bruta
}

// Pool entrega um banco só para este teste: um schema próprio, migrado,
// apagado no fim.
//
// Schema por teste, e não um TRUNCATE compartilhado, porque o `go test ./...`
// roda os pacotes EM PARALELO — com um schema só, um pacote apagava as linhas
// do outro e a suíte passava sozinha e falhava em conjunto. Isolar também
// deixa testes paralelos dentro do mesmo pacote funcionarem.
func Pool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := URL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	esquema := nomeDeEsquema(t)

	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("abrir banco: %v", err)
	}
	if _, err := admin.Exec(ctx, `CREATE SCHEMA `+pgIdent(esquema)); err != nil {
		admin.Close()
		t.Fatalf("criar schema %s: %v", esquema, err)
	}
	admin.Close()

	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatalf("url inválida: %v", err)
	}
	cfg.MaxConns = 4
	// search_path na configuração do pool: vale para TODA conexão que ele
	// abrir, inclusive as criadas depois, então as migrações e as consultas
	// caem no schema deste teste sem ninguém qualificar nome de tabela.
	cfg.ConnConfig.RuntimeParams["search_path"] = esquema

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("abrir pool: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		limpeza, cancelar := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancelar()
		faxina, err := pgxpool.New(limpeza, url)
		if err != nil {
			t.Logf("não deu para apagar o schema %s: %v", esquema, err)
			return
		}
		defer faxina.Close()
		if _, err := faxina.Exec(limpeza, `DROP SCHEMA `+pgIdent(esquema)+` CASCADE`); err != nil {
			t.Logf("não deu para apagar o schema %s: %v", esquema, err)
		}
	})

	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrar: %v", err)
	}
	return pool
}

// nomeDeEsquema deriva do nome do teste, para que um schema deixado para trás
// (processo morto no meio) diga de quem era.
func nomeDeEsquema(t *testing.T) string {
	limpo := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_':
			return r
		case r >= 'A' && r <= 'Z':
			return r + 32
		default:
			return '_'
		}
	}, t.Name())
	if len(limpo) > 40 {
		limpo = limpo[:40]
	}
	var sufixo [6]byte
	if _, err := rand.Read(sufixo[:]); err != nil {
		panic("dbtest: sem aleatoriedade: " + err.Error())
	}
	return "t_" + limpo + "_" + hex.EncodeToString(sufixo[:])
}

// pgIdent cita o identificador. Os nomes aqui são gerados por nós, mas um
// identificador interpolado sem citar é o começo de toda injeção.
func pgIdent(nome string) string {
	return `"` + strings.ReplaceAll(nome, `"`, `""`) + `"`
}

// CriarUsuario insere uma conta direto no banco. Os testes do acervo precisam
// de um dono, não de exercitar o cadastro — isso é assunto dos testes de auth.
func CriarUsuario(t *testing.T, pool *pgxpool.Pool, email string) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(), `
		INSERT INTO users (email, name, password_hash)
		VALUES ($1, split_part($1, '@', 1), 'hash-de-teste')
		RETURNING id`, email).Scan(&id)
	if err != nil {
		t.Fatalf("criar usuário %s: %v", email, err)
	}
	return id
}
