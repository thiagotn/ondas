package acervo

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Visibilidade de faixa. São os dois únicos valores que o CHECK da migração
// 0007 aceita, e existem como constante para o handler não precisar repetir
// string literal numa validação.
const (
	VisibilidadePrivada = "privada"
	VisibilidadeTodos   = "todos"
)

// VisibilidadeValida peneira o que vem de JSON. Sem ela um valor desconhecido
// chegaria ao banco e seria barrado pelo CHECK como erro 500, quando é pedido
// malformado — 400.
func VisibilidadeValida(v string) bool {
	return v == VisibilidadePrivada || v == VisibilidadeTodos
}

// Compartilhamento lê o estado de quem pode ouvir uma faixa ALÉM do dono.
//
// Exige ser o dono, como tudo neste arquivo: para quem não é, a faixa não
// existe (`ErrNaoEncontrada` → 404). Saber com quem uma faixa está
// compartilhada é informação do dono dela.
func (r *Tracks) Compartilhamento(ctx context.Context, ownerID, trackID string) (string, []string, error) {
	var vis string
	err := r.pool.QueryRow(ctx,
		`SELECT visibilidade FROM tracks WHERE id = $1 AND user_id = $2`, trackID, ownerID).Scan(&vis)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, ErrNaoEncontrada
	}
	if err != nil {
		return "", nil, fmt.Errorf("compartilhamento: ler faixa: %w", err)
	}
	com, err := concessoes(ctx, r.pool, trackID)
	if err != nil {
		return "", nil, err
	}
	return vis, com, nil
}

// AplicarCompartilhamento muda a visibilidade e/ou as concessões nominais, e
// devolve o estado inteiro que ficou.
//
// Devolver o estado novo em vez de um 204 segue `Users.DefinirPublico` e
// `Likes.Aplicar`: quem chama responde com o que acabou de gravar, e não existe
// uma segunda leitura capaz de discordar da escrita.
//
// `vis` vazia significa "não mexe na visibilidade" — é o que deixa o mesmo
// pedido conceder a uma pessoa sem decidir de novo se a faixa é pública.
//
// `com` e `sem` chegam DISJUNTAS e com ids que existem: é o handler que resolve
// e-mail em id e recusa o resto. Se uma conta for apagada entre a resolução e o
// INSERT, a FK recusa a linha e isto devolve erro — raro, e melhor que gravar
// concessão para quem não existe.
//
// O DONO ENTRA NO SQL, nunca num `if` anterior, pela mesma régua de `PorID`. E
// o `FOR UPDATE` da primeira consulta é o que faz dois pedidos simultâneos para
// a mesma faixa não se intercalarem no meio das três escritas.
func (r *Tracks) AplicarCompartilhamento(
	ctx context.Context, ownerID, trackID, vis string, com, sem []string,
) (string, []string, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return "", nil, fmt.Errorf("compartilhar: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var atual string
	err = tx.QueryRow(ctx,
		`SELECT visibilidade FROM tracks WHERE id = $1 AND user_id = $2 FOR UPDATE`,
		trackID, ownerID).Scan(&atual)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, ErrNaoEncontrada
	}
	if err != nil {
		return "", nil, fmt.Errorf("compartilhar: travar faixa: %w", err)
	}

	if vis != "" && vis != atual {
		if _, err := tx.Exec(ctx,
			`UPDATE tracks SET visibilidade = $3 WHERE id = $1 AND user_id = $2`,
			trackID, ownerID, vis,
		); err != nil {
			return "", nil, fmt.Errorf("compartilhar: visibilidade: %w", err)
		}
		atual = vis
	}

	// Tirar antes de pôr, como em `Likes.Aplicar`: com as listas disjuntas a
	// ordem não decide nada, e nesta a repetição acaba concedida — o resultado
	// menos destrutivo dos dois.
	if len(sem) > 0 {
		if _, err := tx.Exec(ctx,
			`DELETE FROM track_shares WHERE track_id = $1 AND user_id = ANY($2::uuid[])`,
			trackID, sem,
		); err != nil {
			return "", nil, fmt.Errorf("compartilhar: remover concessão: %w", err)
		}
	}
	if len(com) > 0 {
		// `u <> $3` descarta a concessão do dono para si mesmo. Ela não teria
		// efeito nenhum (ele já ouve por ser dono) e seria uma linha que só
		// confunde quem for ler a tabela depois.
		//
		// `ON CONFLICT DO NOTHING` porque conceder a quem já tem é o caso normal
		// de um pedido repetido, e não é erro.
		if _, err := tx.Exec(ctx,
			`INSERT INTO track_shares (track_id, user_id)
			 SELECT $1, u FROM unnest($2::uuid[]) u WHERE u <> $3
			 ON CONFLICT DO NOTHING`,
			trackID, com, ownerID,
		); err != nil {
			return "", nil, fmt.Errorf("compartilhar: conceder: %w", err)
		}
	}

	// Relê DENTRO da transação: é o que garante que a resposta é o estado
	// comitado, e não o que este processo acha que escreveu.
	final, err := concessoes(ctx, tx, trackID)
	if err != nil {
		return "", nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", nil, fmt.Errorf("compartilhar: commit: %w", err)
	}
	return atual, final, nil
}

// consulta é o pouco que `pgxpool.Pool` e `pgx.Tx` têm em comum aqui: permite
// ler as concessões dentro ou fora de transação sem duplicar a consulta.
type consulta interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func concessoes(ctx context.Context, q consulta, trackID string) ([]string, error) {
	linhas, err := q.Query(ctx,
		`SELECT user_id::text FROM track_shares WHERE track_id = $1 ORDER BY created_at`, trackID)
	if err != nil {
		return nil, fmt.Errorf("compartilhar: ler concessões: %w", err)
	}
	defer linhas.Close()

	// `[]string{}` e nunca `nil`, como em `Likes.Listar`: quem serializa quer
	// `[]` no JSON, não `null`.
	ids := []string{}
	for linhas.Next() {
		var id string
		if err := linhas.Scan(&id); err != nil {
			return nil, fmt.Errorf("compartilhar: scan: %w", err)
		}
		ids = append(ids, id)
	}
	if err := linhas.Err(); err != nil {
		return nil, fmt.Errorf("compartilhar: ler concessões: %w", err)
	}
	return ids, nil
}
