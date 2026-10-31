// Package likes guarda as curtidas de cada conta.
//
// Uma curtida é só um par (dono, id da faixa): nenhum metadado é copiado para
// cá. A consequência é deliberada — `--curtidas` continua sendo um filtro
// sobre o catálogo que está carregado, e não uma lista que se basta.
package likes

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Likes struct{ pool *pgxpool.Pool }

func NewLikes(pool *pgxpool.Pool) *Likes { return &Likes{pool: pool} }

// Listar devolve os ids curtidos pelo dono, mais recentes primeiro.
//
// Lista vazia volta como `[]string{}` e nunca como `nil`: quem serializa quer
// `[]` no JSON, não `null` — a PWA trata os dois como "sem curtida nenhuma",
// mas só um deles é o contrato escrito.
func (l *Likes) Listar(ctx context.Context, userID string) ([]string, error) {
	linhas, err := l.pool.Query(ctx,
		`SELECT track_id FROM likes WHERE user_id = $1 ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("likes: listar: %w", err)
	}
	defer linhas.Close()

	ids := []string{}
	for linhas.Next() {
		var id string
		if err := linhas.Scan(&id); err != nil {
			return nil, fmt.Errorf("likes: scan: %w", err)
		}
		ids = append(ids, id)
	}
	if err := linhas.Err(); err != nil {
		return nil, fmt.Errorf("likes: listar: %w", err)
	}
	return ids, nil
}

// Aplicar tira os ids de `remove`, põe os de `add` e devolve a lista inteira
// que ficou.
//
// Devolver a lista nova em vez de um 204 segue `Users.DefinirPublico`: quem
// chama responde com o que acabou de gravar, e não existe uma segunda leitura
// que possa discordar da escrita.
//
// As duas listas chegam DISJUNTAS — quem monta a fila do lado do cliente
// garante isso (`packages/core/src/likes/fila.ts`). É esse invariante que
// dispensa decidir aqui uma ordem entre apagar e inserir; na dúvida, a ordem
// escrita (remove antes de add) é a que faz um id repetido nas duas acabar
// curtido, que é o resultado menos destrutivo.
//
// Tudo numa transação: uma fila acumulada offline pode trazer dezenas de
// mudanças, e aplicar metade delas deixaria o cliente limpando uma fila que
// não subiu inteira.
func (l *Likes) Aplicar(ctx context.Context, userID string, add, remove []string) ([]string, error) {
	tx, err := l.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("likes: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if len(remove) > 0 {
		if _, err := tx.Exec(ctx,
			`DELETE FROM likes WHERE user_id = $1 AND track_id = ANY($2::text[])`,
			userID, remove,
		); err != nil {
			return nil, fmt.Errorf("likes: remover: %w", err)
		}
	}
	if len(add) > 0 {
		// `ON CONFLICT DO NOTHING` em vez de um `SELECT` antes: curtir o que já
		// está curtido é o caso normal de uma fila que subiu duas vezes, e não
		// é erro.
		if _, err := tx.Exec(ctx,
			`INSERT INTO likes (user_id, track_id)
			 SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
			userID, add,
		); err != nil {
			return nil, fmt.Errorf("likes: inserir: %w", err)
		}
	}

	ids, err := lerDentroDaTx(ctx, tx, userID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("likes: commit: %w", err)
	}
	return ids, nil
}

// RemoverFaixa apaga a curtida de uma faixa do acervo que deixou de existir.
//
// É a limpeza que a FK faria sozinha, e que esta tabela não pode ter (ver a
// migração 0006). O id vem PREFIXADO — `acervo:<uuid>` —, porque é assim que
// ele chega ao navegador e é assim que foi curtido.
func (l *Likes) RemoverFaixa(ctx context.Context, trackID string) error {
	if _, err := l.pool.Exec(ctx, `DELETE FROM likes WHERE track_id = $1`, trackID); err != nil {
		return fmt.Errorf("likes: removerFaixa: %w", err)
	}
	return nil
}

func lerDentroDaTx(ctx context.Context, tx pgx.Tx, userID string) ([]string, error) {
	linhas, err := tx.Query(ctx,
		`SELECT track_id FROM likes WHERE user_id = $1 ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("likes: reler: %w", err)
	}
	defer linhas.Close()

	ids := []string{}
	for linhas.Next() {
		var id string
		if err := linhas.Scan(&id); err != nil {
			return nil, fmt.Errorf("likes: scan: %w", err)
		}
		ids = append(ids, id)
	}
	if err := linhas.Err(); err != nil {
		return nil, fmt.Errorf("likes: reler: %w", err)
	}
	return ids, nil
}
