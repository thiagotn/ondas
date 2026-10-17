package ingest

import (
	"context"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Os testes de mídia usam arquivos gerados pelo ffmpeg na hora — nada de
// binário commitado no repo. Sem ffmpeg instalado eles se declaram pulados em
// vez de passar sem exercitar nada.
func exigirFFmpeg(t *testing.T) {
	t.Helper()
	for _, bin := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s não está instalado", bin)
		}
	}
}

func rodar(t *testing.T, args ...string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	saida, err := exec.CommandContext(ctx, args[0], args[1:]...).CombinedOutput()
	require.NoError(t, err, "%s: %s", args[0], saida)
}

// gerarAudio cria um arquivo de áudio de `segundos` com as tags informadas.
func gerarAudio(t *testing.T, dir, nome, codec string, segundos int, titulo, artista string) string {
	t.Helper()
	destino := filepath.Join(dir, nome)
	args := []string{
		"ffmpeg", "-v", "error", "-y",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=" + strconv.Itoa(segundos),
	}
	if codec != "" {
		args = append(args, "-c:a", codec)
	}
	if titulo != "" {
		args = append(args, "-metadata", "title="+titulo)
	}
	if artista != "" {
		args = append(args, "-metadata", "artist="+artista)
	}
	rodar(t, append(args, destino)...)
	return destino
}

func TestExaminaMP3ComTags(t *testing.T) {
	exigirFFmpeg(t)
	dir := t.TempDir()
	arq := gerarAudio(t, dir, "a.mp3", "libmp3lame", 3, "Faixa de Teste", "Fulano")

	m, err := Examinar(context.Background(), arq)
	require.NoError(t, err)
	require.Equal(t, "mp3", m.Codec)
	require.Equal(t, "audio/mpeg", m.ContentType)
	require.Equal(t, "mp3", m.Ext)
	require.Equal(t, "Faixa de Teste", m.Titulo)
	require.Equal(t, "Fulano", m.Artista)
	// O lame arredonda a duração; o que importa é não errar a ordem de grandeza.
	require.InDelta(t, 3, m.DuracaoS, 1)
	require.False(t, m.TemCapa)
}

func TestExaminaFLACEM4A(t *testing.T) {
	exigirFFmpeg(t)
	dir := t.TempDir()

	flac := gerarAudio(t, dir, "a.flac", "flac", 1, "", "")
	m, err := Examinar(context.Background(), flac)
	require.NoError(t, err)
	require.Equal(t, "audio/flac", m.ContentType)

	m4a := gerarAudio(t, dir, "a.m4a", "aac", 1, "", "")
	m, err = Examinar(context.Background(), m4a)
	require.NoError(t, err)
	require.Equal(t, "audio/mp4", m.ContentType)
	require.Equal(t, "m4a", m.Ext)
}

// A régua é o que a tag <audio> toca. Guardar um ac3 seria guardar um arquivo
// que a PWA nunca conseguiria tocar.
func TestFormatoQueONavegadorNaoTocaEhRecusado(t *testing.T) {
	exigirFFmpeg(t)
	dir := t.TempDir()
	arq := gerarAudio(t, dir, "a.ac3", "ac3", 1, "", "")

	_, err := Examinar(context.Background(), arq)
	require.ErrorIs(t, err, ErrFormatoNaoToca)
}

func TestArquivoSemAudioEhRecusado(t *testing.T) {
	exigirFFmpeg(t)
	dir := t.TempDir()
	// Vídeo mudo: o ffprobe lê, mas não há faixa de áudio para tocar.
	mudo := filepath.Join(dir, "mudo.mp4")
	rodar(t, "ffmpeg", "-v", "error", "-y",
		"-f", "lavfi", "-i", "color=c=black:s=64x64:d=1", "-c:v", "libx264", mudo)

	_, err := Examinar(context.Background(), mudo)
	require.ErrorIs(t, err, ErrSemAudio)
}

func TestArquivoQueNaoEhMidiaEhRecusado(t *testing.T) {
	exigirFFmpeg(t)
	dir := t.TempDir()
	lixo := filepath.Join(dir, "lixo.mp3") // extensão mente; conteúdo é texto
	require.NoError(t, os.WriteFile(lixo, []byte("isto não é um mp3"), 0o600))

	_, err := Examinar(context.Background(), lixo)
	require.Error(t, err)
}

func TestCapaEmbutidaEhDetectadaEExtraidaSemAmpliar(t *testing.T) {
	exigirFFmpeg(t)
	dir := t.TempDir()

	// Capa de 300x300 colada num mp3, como fazem os programas de tag.
	capa := filepath.Join(dir, "capa.png")
	rodar(t, "ffmpeg", "-v", "error", "-y",
		"-f", "lavfi", "-i", "color=c=red:s=300x300:d=1", "-frames:v", "1", capa)

	som := gerarAudio(t, dir, "som.mp3", "libmp3lame", 1, "Com Capa", "Alguém")
	comCapa := filepath.Join(dir, "com-capa.mp3")
	rodar(t, "ffmpeg", "-v", "error", "-y", "-i", som, "-i", capa,
		"-map", "0:a", "-map", "1:v", "-c", "copy",
		"-disposition:v:0", "attached_pic", comCapa)

	m, err := Examinar(context.Background(), comCapa)
	require.NoError(t, err)
	require.True(t, m.TemCapa, "capa embutida deveria ter sido detectada")

	// 480 pedido numa capa de 300: tem de continuar 300, não virar borrão.
	grande := filepath.Join(dir, "out-480.jpg")
	require.NoError(t, ExtrairCapa(context.Background(), comCapa, grande, 480))
	l, a := dimensoes(t, grande)
	require.Equal(t, 300, l)
	require.Equal(t, 300, a)

	// 150 pedido na mesma capa: reduz.
	thumb := filepath.Join(dir, "out-150.jpg")
	require.NoError(t, ExtrairCapa(context.Background(), comCapa, thumb, 150))
	l, a = dimensoes(t, thumb)
	require.Equal(t, 150, l)
	require.Equal(t, 150, a)

	// E o thumb tem de ser realmente menor em bytes — é o motivo de existir.
	iGrande, err := os.Stat(grande)
	require.NoError(t, err)
	iThumb, err := os.Stat(thumb)
	require.NoError(t, err)
	require.Less(t, iThumb.Size(), iGrande.Size())
}

// A capa tinha de sair chapada para esta trava fazer sentido: o encoder mjpeg
// do ffmpeg, sem `-q:v`, mira um BITRATE (200kbps) em vez de uma qualidade, e
// come o detalhe de uma foto.
//
// A referência é a MESMA fonte codificada quase sem perda (`-q:v 1`), e não o
// PNG original, de propósito: assim a subamostragem de croma do JPEG está dos
// dois lados e o que a medida isola é só a quantização — que é o que o `-q:v`
// controla. Com o padrão isto dá ~34dB; com `-q:v 2`, ~45dB.
func TestCapaNaoSaiChapada(t *testing.T) {
	exigirFFmpeg(t)
	dir := t.TempDir()

	// Ruído, e não um padrão de barras: o alvo de bitrate do encoder só aperta
	// quando a imagem tem detalhe que não comprime. Medido aqui: com
	// `testsrc2` o padrão dá 45dB e passaria neste teste; com ruído dá 31dB.
	// A semente deixa a medida repetível.
	fonte := filepath.Join(dir, "fonte.png")
	rodar(t, "ffmpeg", "-v", "error", "-y",
		"-f", "lavfi", "-i", "color=c=gray:s=600x600:d=1,noise=alls=40:all_seed=42",
		"-frames:v", "1", fonte)

	som := gerarAudio(t, dir, "som.mp3", "libmp3lame", 1, "Com Capa", "Alguém")
	comCapa := filepath.Join(dir, "com-capa.mp3")
	rodar(t, "ffmpeg", "-v", "error", "-y", "-i", som, "-i", fonte,
		"-map", "0:a", "-map", "1:v", "-c", "copy",
		"-disposition:v:0", "attached_pic", comCapa)

	saida := filepath.Join(dir, "capa.jpg")
	require.NoError(t, ExtrairCapa(context.Background(), comCapa, saida, 600))

	referencia := filepath.Join(dir, "ref.jpg")
	rodar(t, "ffmpeg", "-v", "error", "-y", "-i", comCapa,
		"-an", "-map", "0:v:0", "-vframes", "1", "-q:v", "1", "-f", "image2", referencia)

	db := psnr(t, saida, referencia)
	require.Greater(t, db, 40.0,
		"capa saiu a %.1fdB da referência quase sem perda — qualidade no chão", db)
}

// psnr devolve a diferença média entre duas imagens, em decibéis. Quanto maior,
// mais parecidas; acima de ~40dB a diferença não se vê.
func psnr(t *testing.T, a, b string) float64 {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	saida, err := exec.CommandContext(ctx, "ffmpeg", "-nostdin",
		"-i", a, "-i", b, "-lavfi", "psnr=stats_file=-", "-f", "null", "-").CombinedOutput()
	require.NoError(t, err, "ffmpeg psnr: %s", saida)

	m := regexp.MustCompile(`psnr_avg:([0-9.]+|inf)`).FindSubmatch(saida)
	require.NotNil(t, m, "não achei o psnr na saída do ffmpeg: %s", saida)
	if string(m[1]) == "inf" {
		return math.Inf(1) // imagens idênticas
	}
	v, err := strconv.ParseFloat(string(m[1]), 64)
	require.NoError(t, err)
	return v
}

func TestExtrairCapaFalhaEmArquivoSemCapa(t *testing.T) {
	exigirFFmpeg(t)
	dir := t.TempDir()
	som := gerarAudio(t, dir, "som.mp3", "libmp3lame", 1, "", "")

	err := ExtrairCapa(context.Background(), som, filepath.Join(dir, "x.jpg"), 480)
	require.Error(t, err, "sem stream de vídeo o ffmpeg tem de falhar, e o worker trata isso como faixa sem capa")
}

func dimensoes(t *testing.T, caminho string) (int, int) {
	t.Helper()
	saida, err := exec.Command("ffprobe", "-v", "error",
		"-select_streams", "v:0", "-show_entries", "stream=width,height",
		"-of", "csv=p=0:s=x", caminho).Output()
	require.NoError(t, err)
	var l, a int
	_, err = fmt.Sscanf(strings.TrimSpace(string(saida)), "%dx%d", &l, &a)
	require.NoError(t, err, "saída do ffprobe: %q", saida)
	return l, a
}
