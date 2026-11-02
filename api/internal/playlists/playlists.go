// Package playlists guarda as playlists de cada conta.
//
// Uma playlist é um nome e uma ordem de ids: nenhum metadado de faixa é copiado
// para cá, pela mesma decisão do pacote `likes`. A consequência é deliberada —
// a playlist continua sendo um recorte do catálogo que está carregado, e não
// uma lista que se basta.
//
// Toda escrita devolve A COLEÇÃO INTEIRA que ficou, e não só o que mudou. É o
// padrão de `Users.DefinirPublico`, `Likes.Aplicar` e
// `Tracks.AplicarCompartilhamento`: quem chama responde com o que acabou de
// gravar, e não existe uma segunda leitura capaz de discordar da escrita. Aqui
// isso compra uma coisa a mais — como o estado inteiro vai e volta em cada
// resposta, não há rota de detalhe e, portanto, não há como o índice e o
// detalhe divergirem.
package playlists

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Tetos. Existem pelo mesmo motivo do `maxIDsPorPedido` das curtidas: proteger
// o banco de um `unnest` de tamanho arbitrário. E, como toda resposta carrega o
// estado inteiro, são eles que tornam esse contrato honesto — sem teto, o
// tamanho de `GET /api/playlists` seria ilimitado.
const (
	MaxPorConta = 50
	MaxItens    = 500
	MaxNome     = 60
)

var (
	ErrNaoEncontrada = errors.New("playlist não encontrada")
	ErrNomeEmUso     = errors.New("já existe uma playlist com esse nome")
	ErrDemasiadas    = fmt.Errorf("limite de %d playlists por conta", MaxPorConta)
	ErrItensDemais   = fmt.Errorf("limite de %d faixas por playlist", MaxItens)
)

// Playlist leva as tags de JSON na própria struct, ao contrário de
// `acervo.Track`, que tem um `trackJSON` só para ela no handler. Lá a tradução
// existe de verdade: o id ganha prefixo e as URLs são montadas. Aqui as duas
// formas são idênticas, e um tipo espelho seria duplicação que um dia divergiria.
type Playlist struct {
	ID   string `json:"id"`
	Nome string `json:"nome"`
	// Os ids das faixas, NA ORDEM da playlist. `[]` e nunca `nil`: quem
	// serializa quer `[]` no JSON, como em `Likes.Listar`.
	Itens []string `json:"itens"`
}

type Playlists struct{ pool *pgxpool.Pool }

func NewPlaylists(pool *pgxpool.Pool) *Playlists { return &Playlists{pool: pool} }

// consulta é o pouco que `pgxpool.Pool` e `pgx.Tx` têm em comum aqui: deixa a
// releitura final acontecer DENTRO da transação que acabou de escrever, como em
// `acervo.concessoes`.
type consulta interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// Listar devolve as playlists da conta com os itens de cada uma.
func (p *Playlists) Listar(ctx context.Context, userID string) ([]Playlist, error) {
	return lerTodas(ctx, p.pool, userID)
}

// Criar põe uma playlist vazia e devolve a coleção que ficou.
//
// O teto é conferido DENTRO da mesma transação do INSERT: com duas consultas
// soltas, dois pedidos simultâneos passariam juntos pela contagem e a conta
// acabaria com 51.
func (p *Playlists) Criar(ctx context.Context, userID, nome string) ([]Playlist, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("playlists: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var quantas int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM playlists WHERE user_id = $1`, userID).Scan(&quantas); err != nil {
		return nil, fmt.Errorf("playlists: contar: %w", err)
	}
	if quantas >= MaxPorConta {
		return nil, ErrDemasiadas
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO playlists (user_id, nome) VALUES ($1, $2)`, userID, nome,
	); err != nil {
		return nil, traduzirNome(err, "criar")
	}

	todas, err := lerTodas(ctx, tx, userID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("playlists: commit: %w", err)
	}
	return todas, nil
}

// Renomear troca o nome. O DONO ENTRA NO SQL, nunca num `if` depois da leitura —
// a régua de `acervo.PorID`: para quem não é dono, a playlist não existe.
func (p *Playlists) Renomear(ctx context.Context, userID, id, nome string) ([]Playlist, error) {
	marca, err := p.pool.Exec(ctx,
		`UPDATE playlists SET nome = $3, updated_at = now() WHERE id = $2 AND user_id = $1`,
		userID, id, nome)
	if err != nil {
		return nil, traduzirNome(err, "renomear")
	}
	if marca.RowsAffected() == 0 {
		return nil, ErrNaoEncontrada
	}
	return lerTodas(ctx, p.pool, userID)
}

// Apagar remove a playlist. Os itens vão com ela pela FK (migração 0008).
func (p *Playlists) Apagar(ctx context.Context, userID, id string) ([]Playlist, error) {
	marca, err := p.pool.Exec(ctx,
		`DELETE FROM playlists WHERE id = $2 AND user_id = $1`, userID, id)
	if err != nil {
		return nil, fmt.Errorf("playlists: apagar: %w", err)
	}
	if marca.RowsAffected() == 0 {
		return nil, ErrNaoEncontrada
	}
	return lerTodas(ctx, p.pool, userID)
}

// AplicarItens tira, põe e reordena, nesta ordem, e devolve a coleção inteira.
//
// Os três gestos da tela cabem num pedido só: o modo de seleção manda `add` (e
// não precisa conhecer o que já está na playlist), a barra manda `remove`, e o
// `J`/`K` manda `ordem` — a lista completa como ela deve ficar.
//
// `add` e `remove` chegam DISJUNTAS; é o handler que recusa o id repetido nas
// duas, como em `compartilhar`. Isso é o que dispensa decidir aqui uma ordem
// entre apagar e inserir; na dúvida, a ordem escrita faz um id repetido acabar
// DENTRO da playlist, que é o resultado menos destrutivo.
//
// `FOR UPDATE` na playlist antes de qualquer escrita, como em
// `AplicarCompartilhamento`: é o que impede dois pedidos para a mesma playlist
// de se intercalarem no meio das quatro escritas e deixarem `pos` embaralhado.
func (p *Playlists) AplicarItens(
	ctx context.Context, userID, id string, add, remove, ordem []string,
) ([]Playlist, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("playlists: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var dono string
	err = tx.QueryRow(ctx,
		`SELECT user_id::text FROM playlists WHERE id = $1 AND user_id = $2 FOR UPDATE`,
		id, userID).Scan(&dono)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNaoEncontrada
	}
	if err != nil {
		return nil, fmt.Errorf("playlists: travar: %w", err)
	}

	if len(remove) > 0 {
		if _, err := tx.Exec(ctx,
			`DELETE FROM playlist_items WHERE playlist_id = $1 AND track_id = ANY($2::text[])`,
			id, remove,
		); err != nil {
			return nil, fmt.Errorf("playlists: remover itens: %w", err)
		}
	}

	if len(add) > 0 {
		// O teto é conferido DEPOIS do remove, para que um pedido que troca
		// faixas numa playlist cheia funcione.
		var quantos int
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM playlist_items WHERE playlist_id = $1`, id).Scan(&quantos); err != nil {
			return nil, fmt.Errorf("playlists: contar itens: %w", err)
		}
		// Soma crua, sem descontar as que já estão lá: a conta exata exigiria
		// comparar as listas, e errar para o lado de recusar um pedido que
		// caberia é o lado barato de errar.
		if quantos+len(add) > MaxItens {
			return nil, ErrItensDemais
		}

		// Anexa DEPOIS do último, e a ordinalidade é o que mantém os novos
		// distintos entre si. O `max(pos)` lê o estado do começo da instrução
		// para todas as linhas — ele não vê as que este próprio INSERT está
		// inserindo —, e é justamente por isso que o `+ o` é necessário.
		if _, err := tx.Exec(ctx,
			`INSERT INTO playlist_items (playlist_id, track_id, pos)
			 SELECT $1, u.t,
			        coalesce((SELECT max(pos) FROM playlist_items WHERE playlist_id = $1), 0) + u.o
			   FROM unnest($2::text[]) WITH ORDINALITY AS u(t, o)
			 ON CONFLICT DO NOTHING`,
			id, add,
		); err != nil {
			return nil, fmt.Errorf("playlists: inserir itens: %w", err)
		}
	}

	if len(ordem) > 0 {
		// Reescreve `pos` pela posição na lista recebida. Id que não é item
		// desta playlist simplesmente não casa e é ignorado — a tela manda a
		// lista que ela tem, e ela pode estar um segundo atrasada em relação a
		// outra aba.
		if _, err := tx.Exec(ctx,
			`UPDATE playlist_items SET pos = o.pos
			   FROM unnest($2::text[]) WITH ORDINALITY AS o(track_id, pos)
			  WHERE playlist_items.playlist_id = $1
			    AND playlist_items.track_id = o.track_id`,
			id, ordem,
		); err != nil {
			return nil, fmt.Errorf("playlists: reordenar: %w", err)
		}
	}

	if _, err := tx.Exec(ctx,
		`UPDATE playlists SET updated_at = now() WHERE id = $1`, id,
	); err != nil {
		return nil, fmt.Errorf("playlists: tocar updated_at: %w", err)
	}

	// Relê DENTRO da transação: a resposta é o estado comitado, e não o que
	// este processo acha que escreveu.
	todas, err := lerTodas(ctx, tx, userID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("playlists: commit: %w", err)
	}
	return todas, nil
}

// RemoverFaixa apaga de TODAS as playlists os itens de uma faixa do acervo que
// deixou de existir.
//
// É a limpeza que a FK faria, e que esta tabela não pode ter (ver a migração
// 0008) — irmã de `Likes.RemoverFaixa`. O id vem PREFIXADO (`acervo:<uuid>`),
// porque é assim que ele chega ao navegador e é assim que foi guardado.
func (p *Playlists) RemoverFaixa(ctx context.Context, trackID string) error {
	if _, err := p.pool.Exec(ctx,
		`DELETE FROM playlist_items WHERE track_id = $1`, trackID); err != nil {
		return fmt.Errorf("playlists: removerFaixa: %w", err)
	}
	return nil
}

// lerTodas monta a coleção com duas consultas em vez de um join com agregação:
// o número de idas ao banco é o mesmo (duas, independente de quantas playlists
// existam) e nenhuma das duas precisa lidar com linha de playlist vazia virando
// um array com um NULL dentro.
func lerTodas(ctx context.Context, q consulta, userID string) ([]Playlist, error) {
	linhas, err := q.Query(ctx,
		`SELECT id::text, nome FROM playlists WHERE user_id = $1 ORDER BY created_at`, userID)
	if err != nil {
		return nil, fmt.Errorf("playlists: listar: %w", err)
	}
	defer linhas.Close()

	todas := []Playlist{}
	porID := map[string]int{}
	for linhas.Next() {
		var p Playlist
		if err := linhas.Scan(&p.ID, &p.Nome); err != nil {
			return nil, fmt.Errorf("playlists: scan: %w", err)
		}
		p.Itens = []string{}
		porID[p.ID] = len(todas)
		todas = append(todas, p)
	}
	if err := linhas.Err(); err != nil {
		return nil, fmt.Errorf("playlists: listar: %w", err)
	}
	if len(todas) == 0 {
		return todas, nil
	}

	itens, err := q.Query(ctx,
		`SELECT i.playlist_id::text, i.track_id
		   FROM playlist_items i JOIN playlists p ON p.id = i.playlist_id
		  WHERE p.user_id = $1
		  ORDER BY i.playlist_id, i.pos`, userID)
	if err != nil {
		return nil, fmt.Errorf("playlists: listar itens: %w", err)
	}
	defer itens.Close()

	for itens.Next() {
		var pid, tid string
		if err := itens.Scan(&pid, &tid); err != nil {
			return nil, fmt.Errorf("playlists: scan item: %w", err)
		}
		if i, ok := porID[pid]; ok {
			todas[i].Itens = append(todas[i].Itens, tid)
		}
	}
	if err := itens.Err(); err != nil {
		return nil, fmt.Errorf("playlists: listar itens: %w", err)
	}
	return todas, nil
}

// traduzirNome transforma a violação do índice único em `ErrNomeEmUso`.
//
// Pelo nome do índice na mensagem, como `Users.Create` faz com
// `users_email_lower_idx`: é a convenção do repo, e ela não depende de mapear
// código de erro do Postgres em lugar nenhum.
func traduzirNome(err error, acao string) error {
	if strings.Contains(err.Error(), "playlists_nome_idx") {
		return ErrNomeEmUso
	}
	return fmt.Errorf("playlists: %s: %w", acao, err)
}
