// Package storage fala com o bucket R2 pelo S3 API (minio-go, como a API do
// rachão). O bucket do acervo é PRIVADO: não tem domínio público nem r2.dev, e
// o único jeito de ler um objeto é uma URL assinada emitida aqui (ADR 0011).
package storage

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/cors"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type R2 struct {
	client *minio.Client
	bucket string
	ttl    time.Duration
}

// New aponta para o endpoint S3 da conta Cloudflare.
func New(accountID, keyID, secret, bucket string, ttl time.Duration) (*R2, error) {
	if accountID == "" {
		return nil, fmt.Errorf("storage: R2_ACCOUNT_ID vazio")
	}
	return NewComEndpoint(accountID+".r2.cloudflarestorage.com", true, keyID, secret, bucket, ttl)
}

// NewComEndpoint aceita qualquer endpoint S3 — é o que permite testar contra um
// httptest em vez de contra o R2 de verdade.
func NewComEndpoint(endpoint string, ssl bool, keyID, secret, bucket string, ttl time.Duration) (*R2, error) {
	if keyID == "" || secret == "" || bucket == "" {
		return nil, fmt.Errorf("storage: credenciais ou bucket vazios")
	}
	if ttl <= 0 {
		return nil, fmt.Errorf("storage: TTL da assinatura precisa ser positivo")
	}
	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(keyID, secret, ""),
		Secure: ssl,
		// O R2 não tem regiões como o S3; "auto" é o que ele espera.
		Region: "auto",
	})
	if err != nil {
		return nil, fmt.Errorf("storage: %w", err)
	}
	return &R2{client: client, bucket: bucket, ttl: ttl}, nil
}

func (r *R2) TTL() time.Duration { return r.ttl }

// Enviar grava o objeto. `tamanho` é obrigatório (-1 forçaria upload em partes
// sem necessidade; aqui o arquivo já está em disco e o tamanho é conhecido).
func (r *R2) Enviar(ctx context.Context, key, contentType string, dados io.Reader, tamanho int64) error {
	_, err := r.client.PutObject(ctx, r.bucket, key, dados, tamanho, minio.PutObjectOptions{
		ContentType: contentType,
		// O objeto é privado e a URL é assinada com TTL curto; marcar privado
		// aqui evita que um intermediário resolva guardar cópia.
		CacheControl: "private, max-age=0, no-store",
	})
	if err != nil {
		return fmt.Errorf("storage: enviar %s: %w", key, err)
	}
	return nil
}

// URLAssinada devolve um GET assinado, válido por TTL.
//
// É o que vai no Location do 302. Nunca embutimos isto no catálogo: o catálogo
// é persistido 24h no navegador e a assinatura vence antes.
func (r *R2) URLAssinada(ctx context.Context, key string) (string, error) {
	u, err := r.client.PresignedGetObject(ctx, r.bucket, key, r.ttl, url.Values{})
	if err != nil {
		return "", fmt.Errorf("storage: assinar %s: %w", key, err)
	}
	return u.String(), nil
}

func (r *R2) Remover(ctx context.Context, key string) error {
	if strings.TrimSpace(key) == "" {
		return nil
	}
	if err := r.client.RemoveObject(ctx, r.bucket, key, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("storage: remover %s: %w", key, err)
	}
	return nil
}

// Tamanho confere que o objeto existe e quantos bytes tem.
func (r *R2) Tamanho(ctx context.Context, key string) (int64, error) {
	info, err := r.client.StatObject(ctx, r.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return 0, fmt.Errorf("storage: stat %s: %w", key, err)
	}
	return info.Size, nil
}

// --- CORS do bucket -------------------------------------------------------

// A política do bucket do acervo, como código e não como JSON colado num
// painel: fica versionada, revisável e aplicável de novo sem depender de
// ninguém lembrar o que estava lá.
//
// Por que `GET` precisa de CORS aqui, ao contrário das fotos do prumo (ADR
// 0011): o player da PWA usa `crossOrigin='anonymous'` no `<audio>`, o que põe
// a resposta final do redirect sob checagem de CORS, e o download offline faz
// `fetch` e lê `res.body`, que exige resposta não-opaca. Sem isto o áudio
// simplesmente não toca — e o erro no console não aponta para o bucket.
func politicaCORS(origem string) *cors.Config {
	return cors.NewConfig([]cors.Rule{{
		ID:            "ondas-pwa",
		AllowedOrigin: []string{origem},
		// Só leitura: o upload é do worker, por dentro, com credencial.
		AllowedMethod: []string{http.MethodGet, http.MethodHead},
		// `range` é o que permite o seek; os condicionais deixam o navegador
		// revalidar o que já tem em cache em vez de baixar de novo.
		AllowedHeader: []string{"range", "if-match", "if-none-match"},
		// Sem expor estes, o JavaScript do download offline não consegue ler o
		// tamanho e a barra de progresso fica cega.
		ExposeHeader:  []string{"content-length", "content-range", "accept-ranges", "etag"},
		MaxAgeSeconds: 3600,
	}})
}

// AplicarCORS grava a política no bucket.
func (r *R2) AplicarCORS(ctx context.Context, origem string) error {
	if origem == "" {
		return fmt.Errorf("storage: origem da PWA vazia")
	}
	if err := r.client.SetBucketCors(ctx, r.bucket, politicaCORS(origem)); err != nil {
		return fmt.Errorf("storage: aplicar CORS em %s: %w", r.bucket, err)
	}
	return nil
}

// LerCORS devolve a política que está no bucket, em XML, para conferência.
func (r *R2) LerCORS(ctx context.Context) (string, error) {
	cfg, err := r.client.GetBucketCors(ctx, r.bucket)
	if err != nil {
		return "", fmt.Errorf("storage: ler CORS de %s: %w", r.bucket, err)
	}
	if cfg == nil {
		return "", nil
	}
	xmlBytes, err := xml.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return "", err
	}
	return string(xmlBytes), nil
}
