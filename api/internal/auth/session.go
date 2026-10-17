package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Cookie opaco assinado com HMAC-SHA256 em vez de JWT: quem valida o token é a
// mesma API que o emitiu, então não há motivo para carregar uma biblioteca e a
// superfície de erro de JWT (alg=none, confusão de chave, kid). Formato:
//
//	v1.<base64url(userID.expiraEm)>.<base64url(hmac)>
const sessionVersion = "v1"

var (
	ErrSessaoInvalida = errors.New("sessão inválida")
	ErrSessaoExpirada = errors.New("sessão expirada")
)

type Sessions struct {
	secret []byte
	maxAge time.Duration
	agora  func() time.Time
}

func NewSessions(secret string, maxAge time.Duration) *Sessions {
	return &Sessions{secret: []byte(secret), maxAge: maxAge, agora: time.Now}
}

func (s *Sessions) Sign(userID string) string {
	expira := s.agora().Add(s.maxAge).Unix()
	corpo := base64.RawURLEncoding.EncodeToString([]byte(userID + "." + strconv.FormatInt(expira, 10)))
	return sessionVersion + "." + corpo + "." + s.mac(corpo)
}

// Verify devolve o id do usuário. A ordem importa: confere a assinatura antes
// de olhar a expiração, para não vazar nada sobre um cookie forjado.
func (s *Sessions) Verify(cookie string) (string, error) {
	partes := strings.Split(cookie, ".")
	if len(partes) != 3 || partes[0] != sessionVersion {
		return "", ErrSessaoInvalida
	}
	if !hmac.Equal([]byte(partes[2]), []byte(s.mac(partes[1]))) {
		return "", ErrSessaoInvalida
	}
	bruto, err := base64.RawURLEncoding.DecodeString(partes[1])
	if err != nil {
		return "", ErrSessaoInvalida
	}
	corte := strings.LastIndex(string(bruto), ".")
	if corte < 1 {
		return "", ErrSessaoInvalida
	}
	userID, expiraTxt := string(bruto[:corte]), string(bruto[corte+1:])
	expira, err := strconv.ParseInt(expiraTxt, 10, 64)
	if err != nil {
		return "", ErrSessaoInvalida
	}
	if s.agora().Unix() >= expira {
		return "", ErrSessaoExpirada
	}
	return userID, nil
}

func (s *Sessions) MaxAge() time.Duration { return s.maxAge }

func (s *Sessions) mac(corpo string) string {
	m := hmac.New(sha256.New, s.secret)
	fmt.Fprintf(m, "%s.%s", sessionVersion, corpo)
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}
