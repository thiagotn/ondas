package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/thiagotn/ondas/api/internal/config"
	"github.com/thiagotn/ondas/api/internal/storage"
)

const (
	bytesDoProbe   = 4096
	bytesPedidos   = 1024
	prefixoDoProbe = "diag/"
)

// diagnosticar exercita, com um objeto de descarte, as quatro coisas que o
// acervo precisa do R2: gravar, conferir tamanho, ler com Range por URL
// assinada e apagar.
//
// Serve para separar "a credencial está errada" de "a credencial está certa
// mas falta permissão administrativa" — distinção que custou um diagnóstico
// errado aqui: o primeiro teste que fiz foi justamente o CORS, que é a única
// operação administrativa de todas e falha mesmo com a credencial boa.
//
// O Range é o que mais importa: o Safari exige 206 para tocar mídia, e sem ele
// não há seek em navegador nenhum.
func diagnosticar(_ []string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if !cfg.AcervoConfigurado() {
		return errors.New("sem credencial de R2 (R2_ACCOUNT_ID/ACCESS_KEY_ID/SECRET_ACCESS_KEY)")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	r2, err := storage.New(cfg.R2AccountID, cfg.R2AccessKeyID, cfg.R2SecretAccessKey,
		cfg.R2Bucket, time.Duration(cfg.R2SignedURLTTLS)*time.Second)
	if err != nil {
		return err
	}

	key := prefixoDoProbe + uuid.NewString() + ".bin"
	dados := bytes.Repeat([]byte("ondas"), bytesDoProbe/5)
	fmt.Printf("bucket: %s\nprobe:  %s (%d bytes)\n\n", cfg.R2Bucket, key, len(dados))

	// Apaga mesmo se algo falhar no meio: nada de lixo acumulando em diag/.
	defer func() {
		if err := r2.Remover(context.WithoutCancel(ctx), key); err != nil {
			fmt.Printf("limpeza ............ FALHOU: %v\n", err)
			return
		}
		fmt.Println("limpeza ............ ok (objeto de teste removido)")
	}()

	if err := r2.Enviar(ctx, key, "application/octet-stream",
		bytes.NewReader(dados), int64(len(dados))); err != nil {
		return fmt.Errorf("1/4 gravar falhou: %w", err)
	}
	fmt.Println("1/4 gravar .......... ok")

	tamanho, err := r2.Tamanho(ctx, key)
	if err != nil {
		return fmt.Errorf("2/4 conferir tamanho falhou: %w", err)
	}
	if tamanho != int64(len(dados)) {
		return fmt.Errorf("2/4 tamanho divergente: enviei %d, bucket diz %d", len(dados), tamanho)
	}
	fmt.Printf("2/4 tamanho ......... ok (%d bytes)\n", tamanho)

	url, err := r2.URLAssinada(ctx, key)
	if err != nil {
		return fmt.Errorf("3/4 assinar url falhou: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=0-%d", bytesPedidos-1))
	// Origin como o navegador manda: o player usa crossOrigin='anonymous', então
	// a resposta FINAL do redirect passa por checagem de CORS. O preflight
	// (OPTIONS) só prova a política; é esta resposta que precisa carregar o
	// Allow-Origin — sem ele o áudio não toca e o erro não aponta para o bucket.
	req.Header.Set("Origin", cfg.OrigemPWA)
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("3/4 a url assinada não respondeu: %w", err)
	}
	defer resp.Body.Close()
	corpo, err := io.ReadAll(io.LimitReader(resp.Body, bytesPedidos*2))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusPartialContent {
		return fmt.Errorf("3/4 esperava 206 e vieram %d — sem Range o Safari não "+
			"toca e o seek não funciona", resp.StatusCode)
	}
	if len(corpo) != bytesPedidos {
		return fmt.Errorf("3/4 pedi %d bytes e vieram %d", bytesPedidos, len(corpo))
	}
	if !bytes.Equal(corpo, dados[:bytesPedidos]) {
		return errors.New("3/4 os bytes vieram diferentes do que foi gravado")
	}
	fmt.Printf("3/4 range ........... ok (206, %d bytes, content-range %q)\n",
		len(corpo), resp.Header.Get("Content-Range"))

	permitida := resp.Header.Get("Access-Control-Allow-Origin")
	expostos := resp.Header.Get("Access-Control-Expose-Headers")
	switch {
	case permitida == "":
		fmt.Printf("4/4 cors ............ FALTA: a resposta não trouxe "+
			"Access-Control-Allow-Origin para %s.\n"+
			"                     O áudio NÃO vai tocar na PWA. Falta colar a\n"+
			"                     política de CORS no painel (worker cors).\n", cfg.OrigemPWA)
	case permitida != cfg.OrigemPWA && permitida != "*":
		fmt.Printf("4/4 cors ............ ATENÇÃO: allow-origin é %q, esperado %q\n",
			permitida, cfg.OrigemPWA)
	default:
		fmt.Printf("4/4 cors ............ ok (allow-origin %q, expose %q)\n", permitida, expostos)
	}

	fmt.Println("\nA credencial faz tudo o que o acervo precisa.")
	return nil
}
