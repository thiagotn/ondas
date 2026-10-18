package ingest

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"os/exec"
	"strings"
)

// PicosPorFaixa é quantos trechos medimos por faixa, independente da duração.
//
// A tela nunca desenha mais que isto (a barra mais larga do app cabe ~180
// barras de 2px), e a PWA reduz para o que couber. Guardar mais seria detalhe
// que ninguém vê.
const PicosPorFaixa = 200

// Alfabeto da codificação: um caractere por pico, 6 bits cada.
//
// Tem de ser IGUAL ao de `packages/core/src/waveform.ts`. Se os dois saírem de
// acordo, a forma de onda aparece embaralhada e nada falha em voz alta — é por
// isso que `TestPicosAlfabetoBateComOCore` lê o arquivo do core e compara.
const alfabeto = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

// Taxa de análise. 4 kHz mono é de sobra: cada pico resume centenas de
// milissegundos, então o que interessa é a envoltória, não a banda. A escolha
// é sobre MEMÓRIA — é ela que define o tamanho do balde.
const taxaAnalise = 4000

// Picos mede o volume do áudio em `PicosPorFaixa` trechos iguais e devolve o
// resultado codificado.
//
// O volume de cada trecho é o RMS, não o pico absoluto: o pico cru de um
// trecho de música comprimida está quase sempre no teto, e a forma de onda
// vira um retângulo. O RMS é o que o olho lê como "mais alto aqui".
//
// `duracaoS` vem do ffprobe e serve para dimensionar o balde sem segurar o
// áudio inteiro na memória: a 4 kHz, uma hora de música seriam 28 MB de PCM, e
// este pod divide 1 Gi de emptyDir com o arquivo original. O que fica em
// memória é o buffer de leitura.
func Picos(ctx context.Context, caminho string, duracaoS int) (string, error) {
	if duracaoS <= 0 {
		return "", fmt.Errorf("picos: duração inválida (%d)", duracaoS)
	}

	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-v", "error",
		"-nostdin",
		"-i", caminho,
		"-vn", // a capa embutida não entra na conta
		"-ac", "1",
		"-ar", fmt.Sprint(taxaAnalise),
		"-f", "s16le",
		"-",
	)
	saida, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	var erros bytes.Buffer
	cmd.Stderr = &erros
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("ffmpeg picos: %w", err)
	}

	valores, err := medir(saida, int64(duracaoS)*taxaAnalise)
	if err != nil {
		_ = cmd.Wait()
		return "", fmt.Errorf("ffmpeg picos: %w", err)
	}
	if err := cmd.Wait(); err != nil {
		return "", fmt.Errorf("ffmpeg picos: %w: %s", err, strings.TrimSpace(erros.String()))
	}
	return codificar(valores), nil
}

// medir percorre o PCM de 16 bits e devolve o RMS de cada trecho, já
// normalizado pelo trecho mais alto da faixa.
//
// A normalização é por faixa de propósito: uma gravação inteira baixa
// desenharia um fio reto se a escala fosse absoluta, e o que a barra precisa
// mostrar é o relevo DELA, não quanto ela é alta comparada com outra.
func medir(r io.Reader, amostrasEstimadas int64) ([]float64, error) {
	porBalde := amostrasEstimadas / PicosPorFaixa
	if porBalde < 1 {
		porBalde = 1
	}

	somas := make([]float64, PicosPorFaixa)
	contas := make([]int64, PicosPorFaixa)

	buf := make([]byte, 64*1024)
	var lidas int64
	// `impar` guarda o byte solto quando uma leitura corta uma amostra ao meio.
	var impar []byte
	for {
		n, err := r.Read(buf)
		if n > 0 {
			bloco := buf[:n]
			if len(impar) > 0 {
				bloco = append(impar, bloco...)
				impar = nil
			}
			if sobra := len(bloco) % 2; sobra != 0 {
				impar = append(impar, bloco[len(bloco)-sobra:]...)
				bloco = bloco[:len(bloco)-sobra]
			}
			for i := 0; i+1 < len(bloco); i += 2 {
				v := float64(int16(binary.LittleEndian.Uint16(bloco[i:]))) / 32768
				// O último balde recolhe o que passar da estimativa: a
				// duração do ffprobe erra por frações de segundo, e o fim da
				// faixa é justamente onde o fade precisa aparecer inteiro.
				b := lidas / porBalde
				if b >= PicosPorFaixa {
					b = PicosPorFaixa - 1
				}
				somas[b] += v * v
				contas[b]++
				lidas++
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	if lidas == 0 {
		return nil, fmt.Errorf("nenhuma amostra de áudio")
	}

	valores := make([]float64, PicosPorFaixa)
	teto := 0.0
	for i := range valores {
		if contas[i] == 0 {
			continue
		}
		valores[i] = math.Sqrt(somas[i] / float64(contas[i]))
		if valores[i] > teto {
			teto = valores[i]
		}
	}
	if teto > 0 {
		for i := range valores {
			valores[i] /= teto
		}
	}
	return valores, nil
}

func codificar(valores []float64) string {
	var b strings.Builder
	b.Grow(len(valores))
	ultimo := float64(len(alfabeto) - 1)
	for _, v := range valores {
		n := int(math.Round(math.Min(1, math.Max(0, v)) * ultimo))
		b.WriteByte(alfabeto[n])
	}
	return b.String()
}
