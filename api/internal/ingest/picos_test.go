package ingest

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// nivel traduz um caractere codificado de volta para 0..63, que é a escala em
// que os testes raciocinam.
func nivel(t *testing.T, c byte) int {
	t.Helper()
	i := strings.IndexByte(alfabeto, c)
	require.GreaterOrEqual(t, i, 0, "caractere %q fora do alfabeto", c)
	return i
}

// gerarAudioEmDoisVolumes monta uma faixa cuja forma é conhecida de antemão:
// a primeira metade em volume cheio, a segunda em silêncio. É o mínimo para
// provar que a medição segue o áudio e não o relógio.
func gerarAudioEmDoisVolumes(t *testing.T, dir string, segundos int) string {
	t.Helper()
	destino := filepath.Join(dir, "dois-volumes.mp3")
	metade := segundos / 2
	rodar(t,
		"ffmpeg", "-v", "error", "-y",
		"-f", "lavfi", "-i", "sine=frequency=440:duration="+strconv.Itoa(metade),
		"-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:duration="+strconv.Itoa(segundos-metade),
		"-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1",
		destino,
	)
	return destino
}

func TestPicosSegueOAudio(t *testing.T) {
	exigirFFmpeg(t)
	dir := t.TempDir()
	caminho := gerarAudioEmDoisVolumes(t, dir, 20)

	midia, err := Examinar(context.Background(), caminho)
	require.NoError(t, err)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	picos, err := Picos(ctx, caminho, midia.DuracaoS)
	require.NoError(t, err)
	require.Len(t, picos, PicosPorFaixa)

	// Primeiro quarto: tom puro, perto do teto. Último quarto: silêncio.
	q := PicosPorFaixa / 4
	require.Greater(t, nivel(t, picos[q]), 50, "a metade com som devia estar alta")
	require.Less(t, nivel(t, picos[PicosPorFaixa-q]), 5, "a metade em silêncio devia estar no chão")
}

func TestPicosNormalizaPelaPropriaFaixa(t *testing.T) {
	exigirFFmpeg(t)
	dir := t.TempDir()

	// A mesma onda em dois volumes de gravação. A forma é a mesma, então o
	// desenho tem de ser o mesmo: a barra mostra o relevo da faixa, não quanto
	// ela foi masterizada alto.
	alto := filepath.Join(dir, "alto.wav")
	baixo := filepath.Join(dir, "baixo.wav")
	rodar(t, "ffmpeg", "-v", "error", "-y",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=10", alto)
	rodar(t, "ffmpeg", "-v", "error", "-y",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=10", "-filter:a", "volume=0.1", baixo)

	ctx := context.Background()
	pAlto, err := Picos(ctx, alto, 10)
	require.NoError(t, err)
	pBaixo, err := Picos(ctx, baixo, 10)
	require.NoError(t, err)
	require.Equal(t, pAlto, pBaixo)
}

func TestPicosRecusaDuracaoInvalida(t *testing.T) {
	_, err := Picos(context.Background(), "/dev/null", 0)
	require.Error(t, err)
}

func TestPicosFalhaEmArquivoQueNaoEAudio(t *testing.T) {
	exigirFFmpeg(t)
	dir := t.TempDir()
	lixo := filepath.Join(dir, "lixo.bin")
	require.NoError(t, os.WriteFile(lixo, []byte("isto não é áudio nenhum"), 0o600))

	_, err := Picos(context.Background(), lixo, 10)
	require.Error(t, err, "o worker trata isso como forma de onda ausente, não como ingestão perdida")
}

// A trava que compara este alfabeto com o do core vive do lado de lá
// (`packages/core/src/__tests__/waveform.test.ts`): a imagem da API é
// construída só com `api/` no contexto, então um teste daqui que lesse o
// arquivo do core falharia dentro do Docker — e foi o que aconteceu.
