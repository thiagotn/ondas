// Package history guarda o que cada conta ouviu: o marcador (onde parou) e o
// histórico (o que já passou pelo player).
//
// São duas tabelas com vidas diferentes — a migração 0009 explica por quê.
package history

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MaxItens é o teto do histórico de uma conta.
//
// Duzentas faixas são semanas de escuta e cabem numa resposta só (~30 KiB), o
// que mantém o contrato de "a coleção inteira" das curtidas e dispensa
// paginação numa lista que a PWA nem virtualiza.
const MaxItens = 200

// Marcador é a última faixa da conta e o segundo onde ela parou.
type Marcador struct {
	TrackID string
	Pos     float64
	Dur     float64
	// O relógio de quem ouviu, já limitado ao nosso `now()`.
	Em time.Time
}

// Item é uma linha do histórico: o id e o retrato da faixa.
type Item struct {
	TrackID string
	Titulo  string
	Artista string
	Dur     int
	Em      time.Time
}

type History struct{ pool *pgxpool.Pool }

func NewHistory(pool *pgxpool.Pool) *History { return &History{pool: pool} }

// Marcador devolve o marcador da conta, ou nil se ela nunca ouviu nada.
func (h *History) Marcador(ctx context.Context, userID string) (*Marcador, error) {
	var m Marcador
	err := h.pool.QueryRow(ctx,
		`SELECT track_id, pos_s, dur_s, em FROM playback WHERE user_id = $1`, userID,
	).Scan(&m.TrackID, &m.Pos, &m.Dur, &m.Em)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("history: marcador: %w", err)
	}
	return &m, nil
}

// GravarMarcador grava o marcador SE ele for mais novo que o que está lá, e
// devolve o que ficou — que pode não ser o que foi mandado.
//
// As duas travas moram no SQL, e cada uma tem um teste que cai sem ela:
//
//   - `LEAST($5, now())`: o carimbo é do relógio do aparelho, e um aparelho com a
//     data adiantada gravaria um marcador imbatível. Limitado ao agora, ele no
//     máximo empata com a próxima escrita honesta.
//   - `WHERE playback.em <= EXCLUDED.em`: a escrita que chega atrasada (ficou
//     numa aba sem rede) não passa por cima da que o outro aparelho já fez.
//     `<=` e não `<`: o mesmo aparelho pode gravar duas vezes no mesmo
//     milissegundo limitado, e a segunda é a que vale.
//
// Escrita ignorada NÃO é erro: quem chama recebe o marcador vigente e descobre
// por ele que perdeu.
func (h *History) GravarMarcador(ctx context.Context, userID string, m Marcador) (*Marcador, error) {
	if _, err := h.pool.Exec(ctx, `
		INSERT INTO playback (user_id, track_id, pos_s, dur_s, em)
		VALUES ($1, $2, $3, $4, LEAST($5::timestamptz, now()))
		ON CONFLICT (user_id) DO UPDATE
		   SET track_id = EXCLUDED.track_id, pos_s = EXCLUDED.pos_s,
		       dur_s = EXCLUDED.dur_s, em = EXCLUDED.em, updated_at = now()
		 WHERE playback.em <= EXCLUDED.em`,
		userID, m.TrackID, m.Pos, m.Dur, m.Em,
	); err != nil {
		return nil, fmt.Errorf("history: gravar marcador: %w", err)
	}
	return h.Marcador(ctx, userID)
}

// Listar devolve o histórico da conta, do mais recente para trás.
//
// Lista vazia volta como `[]Item{}` e nunca como `nil`, pelo mesmo contrato de
// `likes.Listar`: no JSON é `[]`, não `null`.
func (h *History) Listar(ctx context.Context, userID string) ([]Item, error) {
	return listar(ctx, h.pool, userID)
}

// Registrar acrescenta faixas ao histórico e devolve a coleção inteira que
// ficou.
//
// Quem chama garante que não há `TrackID` repetido no lote (o handler
// deduplica): dois iguais são dois upserts na mesma linha, e embora aqui cada
// um seja um comando próprio, o resultado dependeria da ordem em que vieram.
//
// `GREATEST` na data pelo mesmo motivo do `WHERE` do marcador: a fila que subiu
// atrasada não pode fazer uma faixa ouvida hoje parecer ouvida ontem.
//
// Tudo numa transação, com a poda dentro: a fila offline pode trazer dezenas de
// faixas, e gravar metade deixaria o cliente limpando uma fila que não subiu
// inteira.
func (h *History) Registrar(ctx context.Context, userID string, itens []Item) ([]Item, error) {
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("history: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, it := range itens {
		if _, err := tx.Exec(ctx, `
			INSERT INTO history (user_id, track_id, titulo, artista, dur_s, tocada_em)
			VALUES ($1, $2, $3, $4, $5, LEAST($6::timestamptz, now()))
			ON CONFLICT (user_id, track_id) DO UPDATE
			   SET titulo = EXCLUDED.titulo, artista = EXCLUDED.artista,
			       dur_s = EXCLUDED.dur_s,
			       tocada_em = GREATEST(history.tocada_em, EXCLUDED.tocada_em)`,
			userID, it.TrackID, it.Titulo, it.Artista, it.Dur, it.Em,
		); err != nil {
			return nil, fmt.Errorf("history: registrar: %w", err)
		}
	}

	// A poda: o que passar do teto, do mais antigo. `track_id` no desempate
	// para a ordem ser total — duas faixas com a mesma data não podem fazer a
	// poda escolher uma hoje e outra amanhã.
	if _, err := tx.Exec(ctx, `
		DELETE FROM history
		 WHERE user_id = $1
		   AND track_id IN (
		       SELECT track_id FROM history WHERE user_id = $1
		        ORDER BY tocada_em DESC, track_id OFFSET $2)`,
		userID, MaxItens,
	); err != nil {
		return nil, fmt.Errorf("history: podar: %w", err)
	}

	ficou, err := listar(ctx, tx, userID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("history: commit: %w", err)
	}
	return ficou, nil
}

// Limpar apaga o histórico da conta. O marcador FICA: "esquecer o que ouvi" e
// "perder onde parei" são dois pedidos, e só o primeiro foi feito.
func (h *History) Limpar(ctx context.Context, userID string) error {
	if _, err := h.pool.Exec(ctx, `DELETE FROM history WHERE user_id = $1`, userID); err != nil {
		return fmt.Errorf("history: limpar: %w", err)
	}
	return nil
}

// RemoverFaixa tira das duas tabelas uma faixa do acervo que deixou de existir,
// para TODAS as contas — quem ouviu uma faixa compartilhada também a tem aqui.
//
// É a limpeza que a FK faria e que estas tabelas não têm (ver a migração 0006).
// O id vem PREFIXADO, `acervo:<uuid>`, que é como ele chega ao navegador. No
// histórico a linha órfã ainda mostraria título e artista de uma faixa que o
// dono apagou; no marcador ela armaria o player com algo que não toca mais.
func (h *History) RemoverFaixa(ctx context.Context, trackID string) error {
	if _, err := h.pool.Exec(ctx, `DELETE FROM history WHERE track_id = $1`, trackID); err != nil {
		return fmt.Errorf("history: removerFaixa: %w", err)
	}
	if _, err := h.pool.Exec(ctx, `DELETE FROM playback WHERE track_id = $1`, trackID); err != nil {
		return fmt.Errorf("history: removerFaixa (marcador): %w", err)
	}
	return nil
}

// consulta é o que `pool` e `tx` têm em comum — o bastante para ler a lista
// dentro ou fora da transação com o mesmo código.
type consulta interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func listar(ctx context.Context, q consulta, userID string) ([]Item, error) {
	linhas, err := q.Query(ctx, `
		SELECT track_id, titulo, artista, dur_s, tocada_em FROM history
		 WHERE user_id = $1 ORDER BY tocada_em DESC, track_id`, userID)
	if err != nil {
		return nil, fmt.Errorf("history: listar: %w", err)
	}
	defer linhas.Close()

	itens := []Item{}
	for linhas.Next() {
		var it Item
		if err := linhas.Scan(&it.TrackID, &it.Titulo, &it.Artista, &it.Dur, &it.Em); err != nil {
			return nil, fmt.Errorf("history: scan: %w", err)
		}
		itens = append(itens, it)
	}
	if err := linhas.Err(); err != nil {
		return nil, fmt.Errorf("history: listar: %w", err)
	}
	return itens, nil
}
