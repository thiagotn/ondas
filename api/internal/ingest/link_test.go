package ingest

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestClassificarLink(t *testing.T) {
	const video = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
	casos := []struct {
		nome, url, canonica string
		tipo                TipoDeLink
		recusa              bool
	}{
		{"watch", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", video, LinkPagina, false},
		{"curto, com rastreador", "https://youtu.be/dQw4w9WgXcQ?si=abc123", video, LinkPagina, false},
		{"music, dentro de uma lista", "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVM1", video, LinkPagina, false},
		{"móvel e http", "http://m.youtube.com/watch?v=dQw4w9WgXcQ&pp=x", video, LinkPagina, false},
		{"shorts", "https://www.youtube.com/shorts/dQw4w9WgXcQ", video, LinkPagina, false},
		{"playlist", "https://www.youtube.com/playlist?list=PLabcdefghijklmnop", "", "", true},
		{"canal", "https://www.youtube.com/@algumcanal", "", "", true},
		{"busca", "https://www.youtube.com/results?search_query=musica", "", "", true},
		{"id com forma errada", "https://www.youtube.com/watch?v=curto", "", "", true},

		{"faixa do soundcloud", "https://soundcloud.com/artista/faixa?in=artista/sets/album&si=1",
			"https://soundcloud.com/artista/faixa", LinkPagina, false},
		{"soundcloud móvel", "https://m.soundcloud.com/artista/faixa",
			"https://soundcloud.com/artista/faixa", LinkPagina, false},
		{"encurtador", "https://on.soundcloud.com/AbCdE", "https://on.soundcloud.com/AbCdE", LinkPagina, false},
		{"set", "https://soundcloud.com/artista/sets/album", "", "", true},
		{"curtidas", "https://soundcloud.com/artista/likes", "", "", true},
		{"perfil", "https://soundcloud.com/artista", "", "", true},

		// Qualquer outro host é mídia, e a URL não é tocada — query incluída,
		// que numa URL assinada é a própria credencial.
		{"mp3 direto", "https://cdn.exemplo.test/a.mp3?sig=xyz", "https://cdn.exemplo.test/a.mp3?sig=xyz", LinkMidia, false},
		{"host parecido não é youtube", "https://youtube.com.exemplo.test/watch?v=dQw4w9WgXcQ",
			"https://youtube.com.exemplo.test/watch?v=dQw4w9WgXcQ", LinkMidia, false},
	}
	for _, c := range casos {
		t.Run(c.nome, func(t *testing.T) {
			canonica, tipo, err := ClassificarLink(c.url)
			if c.recusa {
				require.ErrorIs(t, err, ErrLinkNaoSuportado)
				return
			}
			require.NoError(t, err)
			require.Equal(t, c.canonica, canonica)
			require.Equal(t, c.tipo, tipo)
		})
	}
}
