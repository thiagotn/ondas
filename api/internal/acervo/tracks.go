// Package acervo guarda as faixas próprias e a fila de ingestão.
package acervo

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNaoEncontrada = errors.New("faixa não encontrada")

type Track struct {
	ID        string
	UserID    string
	Title     string
	Artist    string
	Genre     string
	DurS      int
	AudioKey  string
	AudioType string
	SizeBytes int64
	// Vazios quando o arquivo não trazia capa embutida.
	ArtKey      string
	ArtThumbKey string
	// Forma de onda medida na ingestão. Vazia nas faixas anteriores a ela e
	// nas que o ffmpeg não conseguiu medir.
	Peaks string
	// `privada` ou `todos` (migração 0007). `todos` é regra viva: vale para
	// qualquer conta, inclusive as criadas depois da publicação.
	Visibilidade string
	CreatedAt    time.Time
}

// Visivel é uma faixa que ESTE usuário pode ouvir, com as duas coisas que só
// fazem sentido em relação a ele — e que por isso não são colunas da linha.
//
// Existe separada de `Track` porque `Criar`, `PorID` e `Remover` falam da linha
// em si, sem ninguém na frente dela; só a listagem precisa responder "é minha?"
// e "de quem é?".
type Visivel struct {
	Track
	// Nome de exibição do dono (`users.name`). Preenchido sempre, inclusive
	// quando a faixa é minha — quem decide o que mostrar é o handler.
	DonoNome string
	Minha    bool
}

type Tracks struct{ pool *pgxpool.Pool }

func NewTracks(pool *pgxpool.Pool) *Tracks { return &Tracks{pool: pool} }

const colunas = `id, user_id, title, artist, genre, duration_s, audio_key, audio_type,
	size_bytes, coalesce(art_key, ''), coalesce(art_thumb_key, ''), coalesce(peaks, ''),
	visibilidade, created_at`

// condicaoAudivel é o direito de OUVIR, e `$1` é sempre o usuário.
//
// Existe como fragmento único porque dois caminhos precisam dele — a listagem e
// o redirect assinado de `audio`/`arte` — e eles não podem divergir: uma faixa
// que aparece na lista e não toca, ou que toca sem aparecer, são os dois bugs
// que uma segunda cópia desta regra produziria.
//
// NÃO É o direito de MEXER. Apagar e compartilhar continuam exigindo ser o
// dono, e é de propósito que `PorID` e `Remover` não usem isto: é de lá que vem,
// sem código nenhum, "o destinatário não apaga a faixa de quem compartilhou".
//
// Os nomes vêm qualificados com `tracks.` para o fragmento poder entrar em
// consulta com subconsulta sem ambiguidade.
const condicaoAudivel = `(tracks.user_id = $1
		OR tracks.visibilidade = 'todos'
		OR EXISTS (SELECT 1 FROM track_shares s
		            WHERE s.track_id = tracks.id AND s.user_id = $1))`

func scan(row pgx.Row) (*Track, error) {
	var t Track
	err := row.Scan(&t.ID, &t.UserID, &t.Title, &t.Artist, &t.Genre, &t.DurS,
		&t.AudioKey, &t.AudioType, &t.SizeBytes, &t.ArtKey, &t.ArtThumbKey, &t.Peaks,
		&t.Visibilidade, &t.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNaoEncontrada
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// Listar devolve tudo que este usuário pode ouvir: as dele, as marcadas `todos`
// e as que lhe foram concedidas.
//
// O dono vem por SUBCONSULTA e não por JOIN de propósito. `tracks` e `users`
// têm `id` e `created_at` com o mesmo nome, então um JOIN obrigaria a qualificar
// a lista inteira e `colunas` deixaria de ser reusável aqui — duas listas de
// colunas para a mesma tabela é como elas divergem em silêncio. A subconsulta é
// uma busca por chave primária, e custa nada.
func (r *Tracks) Listar(ctx context.Context, userID string) ([]Visivel, error) {
	linhas, err := r.pool.Query(ctx, `
		SELECT `+colunas+`,
		       coalesce((SELECT u.name FROM users u WHERE u.id = tracks.user_id), ''),
		       tracks.user_id = $1
		  FROM tracks
		 WHERE `+condicaoAudivel+`
		 ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer linhas.Close()

	saida := []Visivel{}
	for linhas.Next() {
		var v Visivel
		t := &v.Track
		if err := linhas.Scan(&t.ID, &t.UserID, &t.Title, &t.Artist, &t.Genre, &t.DurS,
			&t.AudioKey, &t.AudioType, &t.SizeBytes, &t.ArtKey, &t.ArtThumbKey, &t.Peaks,
			&t.Visibilidade, &t.CreatedAt, &v.DonoNome, &v.Minha); err != nil {
			return nil, err
		}
		saida = append(saida, v)
	}
	return saida, linhas.Err()
}

// PorID filtra por usuário na própria consulta: a autorização não pode ficar
// num `if` depois da leitura, senão um id de outro dono vaza metadados antes da
// checagem.
//
// É o direito de MEXER — só o dono. Para tocar, ver `PorIDAudivel`.
func (r *Tracks) PorID(ctx context.Context, userID, id string) (*Track, error) {
	return scan(r.pool.QueryRow(ctx,
		`SELECT `+colunas+` FROM tracks WHERE id = $1 AND user_id = $2`, id, userID))
}

// PorIDAudivel é o `PorID` do direito de OUVIR, e é o que `audio` e `arte`
// usam. Com `PorID` ali, a faixa compartilhada apareceria na lista e morreria
// num 404 ao tocar.
func (r *Tracks) PorIDAudivel(ctx context.Context, userID, id string) (*Track, error) {
	return scan(r.pool.QueryRow(ctx,
		`SELECT `+colunas+` FROM tracks WHERE tracks.id = $2 AND `+condicaoAudivel,
		userID, id))
}

type Nova struct {
	ID          string
	UserID      string
	Title       string
	Artist      string
	Genre       string
	DurS        int
	AudioKey    string
	AudioType   string
	SizeBytes   int64
	ArtKey      string
	ArtThumbKey string
	Peaks       string
	// Vazia vira `privada` no SQL: o worker só a preenche quando o pedido de
	// ingestão disse `para: todos`.
	Visibilidade string
}

func (r *Tracks) Criar(ctx context.Context, n Nova) (*Track, error) {
	// Strings vazias viram NULL: a coluna de capa é opcional e `''` como key
	// seria um caminho inválido esperando para ser usado.
	var art, thumb, picos *string
	if n.ArtKey != "" {
		art = &n.ArtKey
	}
	if n.ArtThumbKey != "" {
		thumb = &n.ArtThumbKey
	}
	if n.Peaks != "" {
		picos = &n.Peaks
	}
	// `nullif(…, '')` deixa o DEFAULT da coluna valer quando ninguém escolheu
	// visibilidade — e o default é `privada`, de modo que um campo esquecido no
	// caminho da ingestão nunca publica faixa por acidente.
	return scan(r.pool.QueryRow(ctx, `
		INSERT INTO tracks (id, user_id, title, artist, genre, duration_s,
		                    audio_key, audio_type, size_bytes, art_key, art_thumb_key, peaks,
		                    visibilidade)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
		        coalesce(nullif($13, ''), 'privada'))
		RETURNING `+colunas,
		n.ID, n.UserID, n.Title, n.Artist, n.Genre, n.DurS,
		n.AudioKey, n.AudioType, n.SizeBytes, art, thumb, picos, n.Visibilidade))
}

// Remover apaga a linha e devolve o que foi apagado, para que quem chamou
// saiba quais objetos limpar no R2.
func (r *Tracks) Remover(ctx context.Context, userID, id string) (*Track, error) {
	t, err := scan(r.pool.QueryRow(ctx,
		`DELETE FROM tracks WHERE id = $1 AND user_id = $2 RETURNING `+colunas, id, userID))
	if err != nil {
		return nil, fmt.Errorf("remover faixa: %w", err)
	}
	return t, nil
}
