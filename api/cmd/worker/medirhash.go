package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/thiagotn/ondas/api/internal/config"
	"github.com/thiagotn/ondas/api/internal/db"
	"github.com/thiagotn/ondas/api/internal/storage"
)

type faixaSemHash struct {
	ID       string
	UserID   string
	Title    string
	AudioKey string
}

func faixasSemHash(ctx context.Context, pool *pgxpool.Pool) ([]faixaSemHash, error) {
	linhas, err := pool.Query(ctx, `
		SELECT id, user_id, title, audio_key
		  FROM tracks
		 WHERE audio_sha256 IS NULL
		 ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer linhas.Close()

	var saida []faixaSemHash
	for linhas.Next() {
		var f faixaSemHash
		if err := linhas.Scan(&f.ID, &f.UserID, &f.Title, &f.AudioKey); err != nil {
			return nil, err
		}
		saida = append(saida, f)
	}
	return saida, linhas.Err()
}

// medirHash preenche `tracks.audio_sha256` das faixas ingeridas antes da
// migração 0014.
//
// Sem ele a recusa de faixa repetida só enxerga o que entrou depois da 0014:
// reenviar um arquivo que já estava no acervo passaria, porque a faixa antiga
// não tem com o que ser comparada.
//
// Diferente do `medir-capas`, este BAIXA cada áudio — não há como saber o hash
// sem ler os bytes (o ETag do R2 não serve: em envio multipart ele não é o MD5
// do objeto). O arquivo passa direto pelo hash, sem tocar o disco.
//
// Os pares repetidos que ele encontrar são só LISTADOS. Nada é apagado: a
// segunda cópia é faixa de alguém, pode estar em playlist, e quem decide é o
// dono (pelo app) ou o admin (pelo painel).
//
// Não escreve nada sem `--gravar`, e a guarda `audio_sha256 IS NULL` se repete
// no UPDATE, como nos outros comandos de operador.
func medirHash(args []string) error {
	fs := flag.NewFlagSet("medir-hash", flag.ContinueOnError)
	gravar := fs.Bool("gravar", false, "escreve no banco; sem isto só lista o que mudaria")
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

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
	defer cancel()

	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	faixas, err := faixasSemHash(ctx, pool)
	if err != nil {
		return fmt.Errorf("listar faixas sem hash: %w", err)
	}
	if len(faixas) == 0 {
		fmt.Println("nada a fazer: toda faixa já tem hash.")
		return nil
	}

	modo := "ENSAIO (nada será escrito; use --gravar)"
	if *gravar {
		modo = "GRAVANDO"
	}
	fmt.Printf("%d faixa(s) sem hash — %s\n\n", len(faixas), modo)

	r2, err := storage.New(cfg.R2AccountID, cfg.R2AccessKeyID, cfg.R2SecretAccessKey,
		cfg.R2Bucket, time.Duration(cfg.R2SignedURLTTLS)*time.Second)
	if err != nil {
		return err
	}

	// dono+hash → a primeira faixa vista com ele. As que já tinham hash entram
	// antes, para um par "antiga × nova" também aparecer.
	vistos, err := hashesJaMedidos(ctx, pool)
	if err != nil {
		return fmt.Errorf("ler hashes já medidos: %w", err)
	}

	var ok, falhas, repetidas int
	for i, f := range faixas {
		resumo := sha256.New()
		// Limite 0 = sem teto: a faixa já está no acervo, e o teto de ingestão
		// pode ter diminuído desde que ela entrou.
		if _, _, err := r2.Baixar(ctx, f.AudioKey, resumo, 0); err != nil {
			fmt.Printf("[%d/%d] %s (%s): FALHOU: %v\n", i+1, len(faixas), f.Title, f.ID, err)
			falhas++
			continue
		}
		sha := hex.EncodeToString(resumo.Sum(nil))
		chave := f.UserID + "/" + sha
		if outra, ja := vistos[chave]; ja {
			fmt.Printf("[%d/%d] %s (%s): REPETIDA de %s\n", i+1, len(faixas), f.Title, f.ID, outra)
			repetidas++
		} else {
			vistos[chave] = f.ID
			fmt.Printf("[%d/%d] %s (%s): %s\n", i+1, len(faixas), f.Title, f.ID, sha[:12])
		}
		if !*gravar {
			ok++
			continue
		}
		if _, err := pool.Exec(ctx,
			`UPDATE tracks SET audio_sha256 = $1 WHERE id = $2 AND audio_sha256 IS NULL`, sha, f.ID); err != nil {
			fmt.Printf("    não gravou: %v\n", err)
			falhas++
			continue
		}
		ok++
	}

	fmt.Printf("\n%d medida(s), %d falha(s), %d repetida(s) na mesma conta (nenhuma foi apagada).\n",
		ok, falhas, repetidas)
	if falhas > 0 {
		return fmt.Errorf("%d faixa(s) não foram medidas", falhas)
	}
	return nil
}

func hashesJaMedidos(ctx context.Context, pool *pgxpool.Pool) (map[string]string, error) {
	linhas, err := pool.Query(ctx, `
		SELECT user_id, audio_sha256, id FROM tracks
		 WHERE audio_sha256 IS NOT NULL ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer linhas.Close()

	vistos := map[string]string{}
	for linhas.Next() {
		var dono, sha, id string
		if err := linhas.Scan(&dono, &sha, &id); err != nil {
			return nil, err
		}
		// DESC + sobrescrita = fica a mais antiga de cada par.
		vistos[dono+"/"+sha] = id
	}
	return vistos, linhas.Err()
}
