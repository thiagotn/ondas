package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/thiagotn/ondas/api/internal/config"
	"github.com/thiagotn/ondas/api/internal/db"
	"github.com/thiagotn/ondas/api/internal/storage"
)

// Quantos bytes pedir no teste de Range. Qualquer valor serve; 1KiB é pequeno
// o bastante para não pesar e grande o bastante para não cair num arquivo
// menor que o pedido.
const bytesDeTeste = 1024

// conferir prova, para uma faixa já ingerida, que o arquivo está no bucket e
// que a URL assinada aceita Range.
//
// Vai pela URL assinada, não pela API do S3, porque é exatamente o caminho que
// o navegador vai seguir depois do 302. E Range importa mais do que parece: o
// Safari exige 206 para tocar mídia, e sem isso o seek não funciona em
// navegador nenhum.
func conferir(args []string) error {
	if len(args) != 1 {
		return errors.New("uso: worker conferir <track-id>")
	}
	id := args[0]
	if _, err := uuid.Parse(id); err != nil {
		return fmt.Errorf("%q não é um uuid de faixa", id)
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if !cfg.AcervoConfigurado() {
		return errors.New("sem credencial de R2")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	// Consulta direta, sem passar pelo repositório: o `PorID` de lá exige o
	// dono de propósito, e eu não quero criar um "busca só pelo id" que um dia
	// alguém usa num handler e vaza faixa de outra conta.
	var key, titulo, tipo string
	var tamanhoBanco int64
	err = pool.QueryRow(ctx,
		`SELECT audio_key, title, audio_type, size_bytes FROM tracks WHERE id = $1`, id).
		Scan(&key, &titulo, &tipo, &tamanhoBanco)
	if err != nil {
		return fmt.Errorf("faixa %s não está no banco: %w", id, err)
	}
	fmt.Printf("faixa:        %s\nkey:          %s\ntipo:         %s\nbytes (banco): %d\n",
		titulo, key, tipo, tamanhoBanco)

	r2, err := storage.New(cfg.R2AccountID, cfg.R2AccessKeyID, cfg.R2SecretAccessKey,
		cfg.R2Bucket, time.Duration(cfg.R2SignedURLTTLS)*time.Second)
	if err != nil {
		return err
	}

	tamanhoBucket, err := r2.Tamanho(ctx, key)
	if err != nil {
		return fmt.Errorf("o objeto não está no bucket: %w", err)
	}
	if tamanhoBucket != tamanhoBanco {
		return fmt.Errorf("tamanho divergente: banco %d, bucket %d", tamanhoBanco, tamanhoBucket)
	}
	fmt.Printf("bytes (bucket): %d — confere\n", tamanhoBucket)

	url, err := r2.URLAssinada(ctx, key)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=0-%d", bytesDeTeste-1))
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("a URL assinada não respondeu: %w", err)
	}
	defer resp.Body.Close()

	corpo, err := io.ReadAll(io.LimitReader(resp.Body, bytesDeTeste*2))
	if err != nil {
		return err
	}
	fmt.Printf("status:       %d\ncontent-range: %q\naccept-ranges: %q\nbytes vindos:  %d\n",
		resp.StatusCode, resp.Header.Get("Content-Range"),
		resp.Header.Get("Accept-Ranges"), len(corpo))

	if resp.StatusCode != http.StatusPartialContent {
		return fmt.Errorf("esperava 206 (conteúdo parcial) e vieram %d — "+
			"sem isso o Safari não toca e o seek não funciona", resp.StatusCode)
	}
	if len(corpo) != bytesDeTeste {
		return fmt.Errorf("pedi %d bytes e vieram %d", bytesDeTeste, len(corpo))
	}

	fmt.Println("\nOK: objeto no bucket, URL assinada válida e Range honrado.")
	return nil
}
