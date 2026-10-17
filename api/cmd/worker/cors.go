package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/thiagotn/ondas/api/internal/config"
	"github.com/thiagotn/ondas/api/internal/storage"
)

// aplicarCORS imprime a política (sem argumento) ou tenta gravá-la no bucket.
//
// Imprimir é o caminho normal, e não um consolo: gravar CORS é **configuração
// de bucket**, o que exige token `Admin Read & Write` — e na Cloudflare esse
// nível é de CONTA INTEIRA, sem como escopar a um bucket. Guardar uma
// credencial dessas no cluster para uma operação feita uma vez seria pior que
// colar o JSON no painel. O token do app continua sendo `Object Read & Write`
// escopado, que é o mínimo necessário para o que ele faz de verdade.
func aplicarCORS(args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	origem := cfg.OrigemPWA
	if len(args) == 1 {
		origem = args[0]
	} else if len(args) > 1 {
		return errors.New("uso: worker cors [https://origem.da.pwa]")
	}

	politica, err := storage.PoliticaCORSJSON(origem)
	if err != nil {
		return err
	}

	if !cfg.AcervoConfigurado() {
		// Sem credencial ainda dá para fazer o que importa: mostrar o que colar.
		imprimirParaPainel(cfg.R2Bucket, origem, politica)
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	r2, err := storage.New(cfg.R2AccountID, cfg.R2AccessKeyID, cfg.R2SecretAccessKey,
		cfg.R2Bucket, time.Duration(cfg.R2SignedURLTTLS)*time.Second)
	if err != nil {
		return err
	}

	if err := r2.AplicarCORS(ctx, origem); err != nil {
		if ehAcessoNegado(err) {
			// Saída ZERO: com o token escopado do app isto é o esperado, não
			// uma falha. Quem chama (o script de setup) precisa seguir adiante
			// mostrando o JSON — travar aqui esconderia o resto da verificação.
			slog.Warn("o token escopado não configura bucket; cole a política no painel",
				"bucket", cfg.R2Bucket)
			imprimirParaPainel(cfg.R2Bucket, origem, politica)
			return nil
		}
		return err
	}

	// Ler de volta é o que prova que gravou — o PUT pode devolver 200 e o
	// bucket ficar sem nada se a política for recusada em silêncio.
	noBucket, err := r2.LerCORS(ctx)
	if err != nil {
		return fmt.Errorf("gravou mas não deu para conferir: %w", err)
	}
	if !strings.Contains(noBucket, origem) {
		return fmt.Errorf("a política no bucket não contém %q:\n%s", origem, noBucket)
	}
	slog.Info("CORS aplicado", "bucket", cfg.R2Bucket, "origem", origem)
	fmt.Println(noBucket)
	return nil
}

func ehAcessoNegado(err error) bool {
	m := strings.ToLower(err.Error())
	return strings.Contains(m, "access denied") || strings.Contains(m, "accessdenied") ||
		strings.Contains(m, "forbidden")
}

func imprimirParaPainel(bucket, origem, politica string) {
	fmt.Printf(`
Cole esta política em: Cloudflare -> R2 -> %s -> Settings -> CORS policy
(origem: %s)

%s

Por que no painel e não por API: CORS é configuração de bucket e exige token
Admin Read & Write, que é de conta inteira. O token do app é Object Read &
Write escopado a este bucket — o mínimo de que ele precisa.
`, bucket, origem, politica)
}
