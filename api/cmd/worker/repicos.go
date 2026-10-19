package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/thiagotn/ondas/api/internal/config"
	"github.com/thiagotn/ondas/api/internal/db"
	"github.com/thiagotn/ondas/api/internal/ingest"
	"github.com/thiagotn/ondas/api/internal/storage"
)

// faixaSemPicos é o mínimo para medir de novo: onde está o áudio e quanto ele
// dura (o `Picos` precisa da duração para dimensionar o balde sem segurar o
// arquivo inteiro na memória).
type faixaSemPicos struct {
	ID       string
	Title    string
	AudioKey string
	DurS     int
}

// faixasSemPicos lista o que ficou sem forma de onda.
//
// Consulta direta e SEM dono, como em `conferir.go` e pelo mesmo motivo: o
// repositório exige o usuário de propósito, e eu não quero criar lá um "lista
// de todo mundo" que um dia alguém chama de dentro de um handler. Isto é
// manutenção de operador, roda com a credencial do cluster e nunca é servido.
//
// `peaks IS NULL OR peaks = ''` porque os dois existem: nulo é quem foi
// ingerido antes da coluna (migração 0004), e vazio é quem o ffmpeg não
// conseguiu medir — o worker grava string vazia nesse caso.
func faixasSemPicos(ctx context.Context, pool *pgxpool.Pool) ([]faixaSemPicos, error) {
	linhas, err := pool.Query(ctx, `
		SELECT id, title, audio_key, duration_s
		FROM tracks
		WHERE peaks IS NULL OR peaks = ''
		ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer linhas.Close()

	saida := []faixaSemPicos{}
	for linhas.Next() {
		var f faixaSemPicos
		if err := linhas.Scan(&f.ID, &f.Title, &f.AudioKey, &f.DurS); err != nil {
			return nil, err
		}
		saida = append(saida, f)
	}
	return saida, linhas.Err()
}

// gravarPicos escreve a forma de onda medida.
//
// A guarda `peaks IS NULL OR peaks = ''` se repete aqui de propósito: entre a
// listagem e a gravação pode ter entrado uma ingestão nova para a mesma faixa,
// e este comando é de recuperação — ele nunca deve passar por cima de uma
// medição mais recente que a dele.
func gravarPicos(ctx context.Context, pool *pgxpool.Pool, id, picos string) (bool, error) {
	tag, err := pool.Exec(ctx, `
		UPDATE tracks SET peaks = $1
		WHERE id = $2 AND (peaks IS NULL OR peaks = '')`, picos, id)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// repicos remede a forma de onda das faixas que estão sem ela.
//
// Existe porque a medição chegou depois do acervo (migração 0004): quem foi
// ingerido antes ficou com barra lisa, e reingerir resolveria ao custo de um
// UUID novo — o que mata os links `/t/...` já compartilhados e sobe de novo um
// áudio que já está no bucket. Aqui o id, a capa e o arquivo ficam onde estão;
// muda uma coluna de 200 bytes.
//
// Não escreve nada sem `--gravar`: a conferência vem antes, e o padrão de um
// comando que mexe em produção tem de ser o inofensivo.
func repicos(args []string) error {
	fs := flag.NewFlagSet("repicos", flag.ContinueOnError)
	gravar := fs.Bool("gravar", false, "escreve no banco; sem isto só lista o que mudaria")
	limite := fs.Int("limite", 0, "no máximo N faixas (0 = todas)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if !cfg.AcervoConfigurado() {
		return errors.New("sem credencial de R2")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	faixas, err := faixasSemPicos(ctx, pool)
	if err != nil {
		return fmt.Errorf("listar faixas sem picos: %w", err)
	}
	if *limite > 0 && len(faixas) > *limite {
		faixas = faixas[:*limite]
	}
	if len(faixas) == 0 {
		fmt.Println("nada a fazer: toda faixa já tem forma de onda.")
		return nil
	}

	modo := "ENSAIO (nada será escrito; use --gravar)"
	if *gravar {
		modo = "GRAVANDO"
	}
	fmt.Printf("%d faixa(s) sem forma de onda — %s\n\n", len(faixas), modo)

	r2, err := storage.New(cfg.R2AccountID, cfg.R2AccessKeyID, cfg.R2SecretAccessKey,
		cfg.R2Bucket, time.Duration(cfg.R2SignedURLTTLS)*time.Second)
	if err != nil {
		return err
	}
	maxBytes := int64(cfg.IngestMaxMB) << 20

	var ok, falhas int
	for i, f := range faixas {
		fmt.Printf("[%d/%d] %s (%s)\n", i+1, len(faixas), f.Title, f.ID)
		picos, err := medirUma(ctx, r2, f, maxBytes)
		if err != nil {
			// Uma faixa ilegível não interrompe as outras: o objetivo é
			// recuperar o que der, e o que não der aparece no fim com o motivo.
			fmt.Printf("        ✗ %v\n", err)
			falhas++
			continue
		}
		if !*gravar {
			fmt.Printf("        ✓ mediria %d caracteres\n", len(picos))
			ok++
			continue
		}
		escreveu, err := gravarPicos(ctx, pool, f.ID, picos)
		if err != nil {
			fmt.Printf("        ✗ gravar: %v\n", err)
			falhas++
			continue
		}
		if !escreveu {
			fmt.Printf("        · pulada: ganhou forma de onda enquanto eu media\n")
			continue
		}
		fmt.Printf("        ✓ gravados %d caracteres\n", len(picos))
		ok++
	}

	fmt.Printf("\n%d medida(s), %d falha(s)\n", ok, falhas)
	if !*gravar {
		fmt.Println("ensaio: nada foi escrito. Repita com --gravar para valer.")
	}
	if falhas > 0 {
		return fmt.Errorf("%d faixa(s) não puderam ser medidas", falhas)
	}
	return nil
}

// medirUma baixa o áudio para o disco e roda o mesmo medidor da ingestão.
//
// Vai para arquivo, e não para memória: o `Picos` chama o ffmpeg sobre um
// caminho, e este pod divide 1 Gi de emptyDir — segurar a faixa inteira em
// memória aqui seria o problema que o próprio `Picos` evita.
func medirUma(ctx context.Context, r2 *storage.R2, f faixaSemPicos, maxBytes int64) (string, error) {
	if f.DurS <= 0 {
		return "", fmt.Errorf("duração %d no banco: o ffprobe não mediu na ingestão", f.DurS)
	}
	dir, err := os.MkdirTemp(dirTrabalho, "repicos-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)

	caminho := filepath.Join(dir, "audio")
	arq, err := os.Create(caminho)
	if err != nil {
		return "", err
	}
	_, n, err := r2.Baixar(ctx, f.AudioKey, arq, maxBytes)
	if cerr := arq.Close(); err == nil && cerr != nil {
		err = cerr
	}
	if err != nil {
		return "", fmt.Errorf("baixar %s: %w", f.AudioKey, err)
	}
	if maxBytes > 0 && n > maxBytes {
		return "", fmt.Errorf("objeto maior que o teto de %d bytes", maxBytes)
	}

	picos, err := ingest.Picos(ctx, caminho, f.DurS)
	if err != nil {
		return "", err
	}
	if picos == "" {
		return "", errors.New("medição devolveu vazio")
	}
	return picos, nil
}
