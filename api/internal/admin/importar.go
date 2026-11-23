package admin

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DoEnv é o que morava no ConfigMap até a migração 0012.
type DoEnv struct {
	// `SIGNUP_OPEN`.
	CadastroAberto bool
	// `SIGNUP_ALLOWLIST`, separada por vírgula.
	Allowlist string
	// `INGEST_DESTINOS`, separada por vírgula.
	Destinos string
}

// Lista quebra uma lista de e-mails separada por vírgula, em minúsculas e sem
// repetição — o mesmo critério do índice único de `users`.
func Lista(csv string) []string {
	visto := map[string]bool{}
	saida := []string{}
	for _, e := range strings.Split(csv, ",") {
		e = strings.ToLower(strings.TrimSpace(e))
		if e == "" || visto[e] {
			continue
		}
		visto[e] = true
		saida = append(saida, e)
	}
	return saida
}

// ImportarEnv traz para o banco, UMA vez, o que o ConfigMap dizia.
//
// É o que deixa o deploy desta versão não mudar nada para ninguém: quem estava
// liberado continua liberado, e só depois disso as três variáveis podem sair
// do cluster. Roda numa transação com um marcador (`env_importado`): da
// segunda subida em diante é uma leitura e nada mais — inclusive se o admin já
// tiver mudado tudo pela tela, que é exatamente quando reimportar faria estrago.
//
// O que cada lista vira:
//
//   - allowlist: e-mail SEM conta vira convite. E-mail com conta é ignorado — a
//     conta já existe, e o convite não teria o que aprovar.
//   - destinos: e-mail COM conta ganha `recebe_do_bot`. Sem conta, a marca vai
//     para o convite dele, SE houver; se não houver, é descartada e logada.
//     Criar o convite aqui pré-aprovaria um cadastro que o env nunca aprovou:
//     estar em `INGEST_DESTINOS` nunca deixou ninguém pular a análise.
//
// Devolve `true` quando importou agora.
func ImportarEnv(ctx context.Context, pool *pgxpool.Pool, env DoEnv) (bool, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("admin: importar env: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// O INSERT do marcador é a trava: duas réplicas subindo juntas disputam a
	// chave primária, e a que perder espera o commit da outra e sai sem fazer
	// nada.
	tag, err := tx.Exec(ctx, `
		INSERT INTO config (chave, valor) VALUES ($1, 'true') ON CONFLICT (chave) DO NOTHING`,
		chaveEnvImportado)
	if err != nil {
		return false, fmt.Errorf("admin: importar env: marcador: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}

	if err := gravarConfig(ctx, tx, chaveCadastroAberto, boolTexto(env.CadastroAberto)); err != nil {
		return false, err
	}

	temConta := func(email string) (bool, error) {
		var existe bool
		err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM users WHERE lower(email) = $1)`, email).Scan(&existe)
		return existe, err
	}

	convites := 0
	for _, email := range Lista(env.Allowlist) {
		if !reEmail.MatchString(email) {
			slog.Warn("importar env: e-mail malformado na allowlist, ignorado")
			continue
		}
		existe, err := temConta(email)
		if err != nil {
			return false, fmt.Errorf("admin: importar env: allowlist: %w", err)
		}
		if existe {
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO convites (email, nota) VALUES ($1, 'importado do SIGNUP_ALLOWLIST')
			ON CONFLICT (email) DO NOTHING`, email); err != nil {
			return false, fmt.Errorf("admin: importar env: convite: %w", err)
		}
		convites++
	}

	destinos, descartados := 0, 0
	for _, email := range Lista(env.Destinos) {
		tag, err := tx.Exec(ctx,
			`UPDATE users SET recebe_do_bot = true WHERE lower(email) = $1`, email)
		if err != nil {
			return false, fmt.Errorf("admin: importar env: destino: %w", err)
		}
		if tag.RowsAffected() > 0 {
			destinos++
			continue
		}
		tag, err = tx.Exec(ctx, `UPDATE convites SET recebe_do_bot = true WHERE email = $1`, email)
		if err != nil {
			return false, fmt.Errorf("admin: importar env: destino no convite: %w", err)
		}
		if tag.RowsAffected() > 0 {
			destinos++
			continue
		}
		// O e-mail vai para o log de propósito: é o único lugar onde o operador
		// fica sabendo quem ficou de fora, e este log não sai do cluster.
		slog.Warn("importar env: destino sem conta e sem convite, descartado", "email", email)
		descartados++
	}

	if err := tx.Commit(ctx); err != nil {
		if errors.Is(err, pgx.ErrTxClosed) {
			return false, nil
		}
		return false, fmt.Errorf("admin: importar env: commit: %w", err)
	}
	slog.Info("configuração importada do ambiente — daqui em diante vale o banco",
		"cadastroAberto", env.CadastroAberto, "convites", convites,
		"destinos", destinos, "descartados", descartados)
	return true, nil
}
