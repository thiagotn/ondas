// Package auth cuida de senha, sessão e do cadastro de usuários.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Parâmetros do argon2id. 64MB/1 passada/4 threads é a recomendação RFC 9106
// para o perfil de segundo-plano — cabe folgado no limite de memória do pod e
// leva ~50ms, que é caro o bastante para quem tenta adivinhar senha.
const (
	argonTime    = 1
	argonMemory  = 64 * 1024
	argonThreads = 4
	argonKeyLen  = 32
	saltLen      = 16
)

var ErrSenhaInvalida = errors.New("credenciais inválidas")

// HashPassword devolve a senha no formato PHC, que carrega os parâmetros
// usados — assim dá para endurecer o custo depois sem invalidar os hashes
// antigos.
func HashPassword(senha string) (string, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("salt: %w", err)
	}
	sum := argon2.IDKey([]byte(senha), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf(
		"$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(sum),
	), nil
}

// VerifyPassword compara em tempo constante. Hash malformado é tratado como
// senha errada: não existe motivo para contar ao cliente que o registro está
// corrompido.
func VerifyPassword(hash, senha string) bool {
	partes := strings.Split(hash, "$")
	if len(partes) != 6 || partes[1] != "argon2id" {
		return false
	}
	var versao int
	if _, err := fmt.Sscanf(partes[2], "v=%d", &versao); err != nil || versao != argon2.Version {
		return false
	}
	var mem uint32
	var tempo uint32
	var threads uint8
	if _, err := fmt.Sscanf(partes[3], "m=%d,t=%d,p=%d", &mem, &tempo, &threads); err != nil {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(partes[4])
	if err != nil {
		return false
	}
	esperado, err := base64.RawStdEncoding.DecodeString(partes[5])
	if err != nil {
		return false
	}
	// `argon2.IDKey` entra em panic com parâmetro zerado (keyLen 0, p=0, m
	// abaixo de 8*p). Hash truncado ou adulterado chega exatamente assim, e um
	// panic no handler de login seria um jeito trivial de derrubar a API.
	if len(salt) == 0 || len(esperado) == 0 || tempo == 0 || threads == 0 || mem < 8*uint32(threads) {
		return false
	}
	calculado := argon2.IDKey([]byte(senha), salt, tempo, mem, threads, uint32(len(esperado)))
	return subtle.ConstantTimeCompare(calculado, esperado) == 1
}
