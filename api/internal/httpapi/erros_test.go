package httpapi

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Os códigos têm de ser únicos: dois erros com o mesmo código são um erro só
// para quem traduz, e a PWA mostraria a frase errada num dos dois.
func TestCodigosSaoUnicos(t *testing.T) {
	vistos := map[string]string{}
	for msg, cod := range codigoPorMensagem {
		if antes, repetido := vistos[cod]; repetido {
			t.Errorf("código %q em duas mensagens: %q e %q", cod, antes, msg)
		}
		vistos[cod] = msg
	}
}

// O guarda que o comentário de `erros.go` promete: toda frase passada a
// `escreverErro` como literal tem de estar na tabela.
//
// Lê o próprio pacote em vez de depender de disciplina. Frase montada com
// número dentro (concatenação) não cai aqui — essas usam `escreverErroCod`,
// que leva o código explícito.
func TestTodoErroTemCodigo(t *testing.T) {
	literal := regexp.MustCompile(`escreverErro\([^,]+,[^,]+,\s*"((?:[^"\\]|\\.)*)"\s*\)`)

	arquivos, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, nome := range arquivos {
		if strings.HasSuffix(nome, "_test.go") {
			continue
		}
		fonte, err := os.ReadFile(nome)
		if err != nil {
			t.Fatal(err)
		}
		for _, achado := range literal.FindAllStringSubmatch(string(fonte), -1) {
			msg := achado[1]
			if _, ok := codigoPorMensagem[msg]; !ok {
				t.Errorf("%s: %q não está em codigoPorMensagem — a PWA não tem como traduzir", nome, msg)
			}
		}
	}
}
