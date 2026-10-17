// Package storage fala com o bucket R2 pelo S3 API (minio-go, como a API do
// rachão). O bucket do acervo é PRIVADO: não tem domínio público nem r2.dev, e
// o único jeito de ler um objeto é uma URL assinada emitida aqui (ADR 0011).
package storage

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
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
