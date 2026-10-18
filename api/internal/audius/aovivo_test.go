package audius

import (
	"context"
	"os"
	"testing"
	"time"
)

// Bate no Audius de verdade. Fora do `go test ./...` por padrão: CI não deve
// depender de terceiro. Rodar com ONDAS_AUDIUS_AO_VIVO=1 antes de mexer no
// formato da resposta.
func TestAoVivo(t *testing.T) {
	if os.Getenv("ONDAS_AUDIUS_AO_VIVO") == "" {
		t.Skip("defina ONDAS_AUDIUS_AO_VIVO=1")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	f, err := New(Opcoes{}).Faixa(ctx, "J72oWO6")
	if err != nil {
		t.Fatalf("faixa: %v", err)
	}
	t.Logf("titulo=%q artista=%q dur=%d capa=%q", f.Titulo, f.Artista, f.Duracao, f.Capa)
	if f.Titulo == "" || f.Artista == "" || f.Capa == "" {
		t.Fatalf("campo vazio: %+v", f)
	}
}
