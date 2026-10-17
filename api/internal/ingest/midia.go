package ingest

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os/exec"
	"strconv"
	"strings"
)

var (
	ErrSemAudio       = errors.New("arquivo não tem faixa de áudio")
	ErrFormatoNaoToca = errors.New("formato que o navegador não toca")
)

// Formatos aceitos: a régua é o que a tag <audio> toca em navegador atual, não
// o que o ffprobe sabe ler. Aceitar um .wma seria guardar um arquivo que a PWA
// nunca conseguiria tocar.
var tiposPorCodec = map[string]struct {
	contentType string
	ext         string
}{
	"mp3":       {"audio/mpeg", "mp3"},
	"aac":       {"audio/mp4", "m4a"},
	"alac":      {"audio/mp4", "m4a"},
	"flac":      {"audio/flac", "flac"},
	"opus":      {"audio/ogg", "opus"},
	"vorbis":    {"audio/ogg", "ogg"},
	"pcm_s16le": {"audio/wav", "wav"},
	"pcm_s24le": {"audio/wav", "wav"},
}

type Midia struct {
	DuracaoS    int
	Titulo      string
	Artista     string
	Codec       string
	ContentType string
	Ext         string
	// Tem capa embutida? (stream de vídeo com disposição de thumbnail)
	TemCapa bool
}

type ffprobeSaida struct {
	Streams []struct {
		CodecName   string            `json:"codec_name"`
		CodecType   string            `json:"codec_type"`
		Disposition map[string]int    `json:"disposition"`
		Tags        map[string]string `json:"tags"`
	} `json:"streams"`
	Format struct {
		Duration string            `json:"duration"`
		Tags     map[string]string `json:"tags"`
	} `json:"format"`
}

// tag procura a chave sem ligar para maiúsculas — cada encoder escreve do seu
// jeito (TITLE, title, Title).
func tag(tags map[string]string, chave string) string {
	for k, v := range tags {
		if strings.EqualFold(k, chave) {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// Examinar roda o ffprobe no arquivo baixado.
//
// É o ffprobe, e não o Content-Type da origem, que decide o que o arquivo é:
// a origem é de fora e pode declarar qualquer coisa.
func Examinar(ctx context.Context, caminho string) (*Midia, error) {
	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-print_format", "json",
		"-show_format",
		"-show_streams",
		caminho,
	)
	var saida, erros bytes.Buffer
	cmd.Stdout = &saida
	cmd.Stderr = &erros
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("ffprobe: %w: %s", err, strings.TrimSpace(erros.String()))
	}

	var p ffprobeSaida
	if err := json.Unmarshal(saida.Bytes(), &p); err != nil {
		return nil, fmt.Errorf("ffprobe: saída ilegível: %w", err)
	}

	m := &Midia{}
	for _, s := range p.Streams {
		switch s.CodecType {
		case "audio":
			if m.Codec == "" {
				m.Codec = s.CodecName
				if t := tag(s.Tags, "title"); t != "" {
					m.Titulo = t
				}
				if a := tag(s.Tags, "artist"); a != "" {
					m.Artista = a
				}
			}
		case "video":
			// Capa embutida aparece como stream de vídeo com attached_pic.
			if s.Disposition["attached_pic"] == 1 {
				m.TemCapa = true
			}
		}
	}
	if m.Codec == "" {
		return nil, ErrSemAudio
	}
	tipo, ok := tiposPorCodec[m.Codec]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrFormatoNaoToca, m.Codec)
	}
	m.ContentType, m.Ext = tipo.contentType, tipo.ext

	// As tags do container valem mais que as do stream: é onde a maioria dos
	// arquivos realmente guarda título e artista.
	if t := tag(p.Format.Tags, "title"); t != "" {
		m.Titulo = t
	}
	if a := tag(p.Format.Tags, "artist"); a != "" {
		m.Artista = a
	}

	seg, err := strconv.ParseFloat(strings.TrimSpace(p.Format.Duration), 64)
	if err != nil || seg <= 0 || math.IsInf(seg, 0) || math.IsNaN(seg) {
		return nil, fmt.Errorf("duração inválida (%q)", p.Format.Duration)
	}
	m.DuracaoS = int(math.Round(seg))
	return m, nil
}

// ExtrairCapa salva a arte embutida redimensionada em `destino` (JPEG).
//
// `lado` é o lado maior; a proporção é preservada e nunca ampliamos uma capa
// pequena (`force_original_aspect_ratio=decrease` + `min(...)`), senão uma arte
// de 100px viraria um borrão de 480.
func ExtrairCapa(ctx context.Context, origem, destino string, lado int) error {
	escala := fmt.Sprintf(
		"scale='min(%d,iw)':'min(%d,ih)':force_original_aspect_ratio=decrease", lado, lado)
	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-v", "error",
		"-nostdin",
		"-y",
		"-i", origem,
		"-an",           // o áudio não interessa aqui
		"-map", "0:v:0", // só a capa
		"-vframes", "1",
		"-vf", escala,
		"-f", "image2",
		destino,
	)
	var erros bytes.Buffer
	cmd.Stderr = &erros
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ffmpeg capa: %w: %s", err, strings.TrimSpace(erros.String()))
	}
	return nil
}
