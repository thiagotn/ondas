package main

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/thiagotn/ondas/api/internal/dbtest"
)

// Insere direto, sem passar pelo repositório, para poder escrever os três
// estados de `peaks` que existem no banco real — inclusive o NULL, que o
// repositório nunca grava mas a migração 0004 deixou para trás.
func inserirFaixa(t *testing.T, pool *pgxpool.Pool, userID, titulo string, picos any) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(), `
		INSERT INTO tracks (user_id, title, artist, genre, duration_s,
		                    audio_key, audio_type, size_bytes, peaks)
		VALUES ($1, $2, 'alguém', 'acervo', 180, 'u/x/a/y.mp3', 'audio/mpeg', 1000, $3)
		RETURNING id`, userID, titulo, picos).Scan(&id)
	require.NoError(t, err)
	return id
}

func TestFaixasSemPicosPegaNuloEVazio(t *testing.T) {
	pool := dbtest.Pool(t)
	ctx := context.Background()
	user := dbtest.CriarUsuario(t, pool, "picos@ondas.app")

	// Os dois estados que significam "sem forma de onda": NULL para quem foi
	// ingerido antes da coluna existir, '' para quem o ffmpeg não mediu.
	inserirFaixa(t, pool, user, "antiga", nil)
	inserirFaixa(t, pool, user, "ffmpeg falhou", "")
	inserirFaixa(t, pool, user, "medida", "ABC")

	faixas, err := faixasSemPicos(ctx, pool)
	require.NoError(t, err)

	titulos := []string{}
	for _, f := range faixas {
		titulos = append(titulos, f.Title)
	}
	// A que já tem forma de onda não entra: este comando é recuperação, não
	// uma remedição geral do acervo.
	require.ElementsMatch(t, []string{"antiga", "ffmpeg falhou"}, titulos)
}

func TestFaixasSemPicosTrazOQuePrecisaParaMedir(t *testing.T) {
	pool := dbtest.Pool(t)
	user := dbtest.CriarUsuario(t, pool, "campos@ondas.app")
	id := inserirFaixa(t, pool, user, "antiga", nil)

	faixas, err := faixasSemPicos(context.Background(), pool)
	require.NoError(t, err)
	require.Len(t, faixas, 1)
	require.Equal(t, id, faixas[0].ID)
	require.Equal(t, "u/x/a/y.mp3", faixas[0].AudioKey)
	// Sem a duração o `Picos` recusa a medir, então ela tem de vir na consulta.
	require.Equal(t, 180, faixas[0].DurS)
}

func TestGravarPicosEscreveQuandoEstavaVazio(t *testing.T) {
	pool := dbtest.Pool(t)
	ctx := context.Background()
	user := dbtest.CriarUsuario(t, pool, "gravar@ondas.app")
	id := inserirFaixa(t, pool, user, "antiga", nil)

	escreveu, err := gravarPicos(ctx, pool, id, "XYZ")
	require.NoError(t, err)
	require.True(t, escreveu)

	var picos string
	require.NoError(t, pool.QueryRow(ctx, `SELECT peaks FROM tracks WHERE id = $1`, id).Scan(&picos))
	require.Equal(t, "XYZ", picos)
}

func TestGravarPicosNaoPassaPorCimaDeMedicaoMaisNova(t *testing.T) {
	pool := dbtest.Pool(t)
	ctx := context.Background()
	user := dbtest.CriarUsuario(t, pool, "corrida@ondas.app")
	// Simula a corrida: a faixa foi listada vazia, mas ganhou forma de onda
	// enquanto este comando media o áudio dela.
	id := inserirFaixa(t, pool, user, "reingerida no meio", "NOVA")

	escreveu, err := gravarPicos(ctx, pool, id, "VELHA")
	require.NoError(t, err)
	require.False(t, escreveu)

	var picos string
	require.NoError(t, pool.QueryRow(ctx, `SELECT peaks FROM tracks WHERE id = $1`, id).Scan(&picos))
	require.Equal(t, "NOVA", picos, "a medição que já estava lá não pode ser sobrescrita")
}
