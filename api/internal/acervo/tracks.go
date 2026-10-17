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
	CreatedAt   time.Time
}

type Tracks struct{ pool *pgxpool.Pool }

func NewTracks(pool *pgxpool.Pool) *Tracks { return &Tracks{pool: pool} }

const colunas = `id, user_id, title, artist, genre, duration_s, audio_key, audio_type,
	size_bytes, coalesce(art_key, ''), coalesce(art_thumb_key, ''), created_at`

func scan(row pgx.Row) (*Track, error) {
	var t Track
	err := row.Scan(&t.ID, &t.UserID, &t.Title, &t.Artist, &t.Genre, &t.DurS,
		&t.AudioKey, &t.AudioType, &t.SizeBytes, &t.ArtKey, &t.ArtThumbKey, &t.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNaoEncontrada
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func (r *Tracks) Listar(ctx context.Context, userID string) ([]Track, error) {
	linhas, err := r.pool.Query(ctx,
		`SELECT `+colunas+` FROM tracks WHERE user_id = $1 ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer linhas.Close()

	saida := []Track{}
	for linhas.Next() {
		t, err := scan(linhas)
		if err != nil {
			return nil, err
		}
		saida = append(saida, *t)
	}
	return saida, linhas.Err()
}

// PorID filtra por usuário na própria consulta: a autorização não pode ficar
// num `if` depois da leitura, senão um id de outro dono vaza metadados antes da
// checagem.
func (r *Tracks) PorID(ctx context.Context, userID, id string) (*Track, error) {
	return scan(r.pool.QueryRow(ctx,
		`SELECT `+colunas+` FROM tracks WHERE id = $1 AND user_id = $2`, id, userID))
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
}

func (r *Tracks) Criar(ctx context.Context, n Nova) (*Track, error) {
	// Strings vazias viram NULL: a coluna de capa é opcional e `''` como key
	// seria um caminho inválido esperando para ser usado.
	var art, thumb *string
	if n.ArtKey != "" {
		art = &n.ArtKey
	}
	if n.ArtThumbKey != "" {
		thumb = &n.ArtThumbKey
	}
	return scan(r.pool.QueryRow(ctx, `
		INSERT INTO tracks (id, user_id, title, artist, genre, duration_s,
		                    audio_key, audio_type, size_bytes, art_key, art_thumb_key)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		RETURNING `+colunas,
		n.ID, n.UserID, n.Title, n.Artist, n.Genre, n.DurS,
		n.AudioKey, n.AudioType, n.SizeBytes, art, thumb))
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
