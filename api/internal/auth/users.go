package auth

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Mesma validação do cliente (`LocalAuthService` em core) — a UI continua
// recusando antes de ir à rede, e a API nunca confia nisso.
var reEmail = regexp.MustCompile(`.+@.+\..+`)

const SenhaMinima = 8

var (
	ErrEmailInvalido = errors.New("e-mail inválido")
	ErrSenhaCurta    = fmt.Errorf("senha precisa de %d+ caracteres", SenhaMinima)
	ErrEmailEmUso    = errors.New("e-mail já cadastrado")
	ErrNaoEncontrado = errors.New("usuário não encontrado")
)

type User struct {
	ID    string `json:"-"`
	Email string `json:"-"`
	// É o único campo que a PWA conhece hoje (`User { name }` em core).
	Name string `json:"name"`
}

type Users struct{ pool *pgxpool.Pool }

func NewUsers(pool *pgxpool.Pool) *Users { return &Users{pool: pool} }

func (u *Users) Create(ctx context.Context, email, senha string) (*User, error) {
	email = strings.TrimSpace(email)
	if !reEmail.MatchString(email) {
		return nil, ErrEmailInvalido
	}
	// A senha mínima aqui é maior que a do protótipo (4): aquela regra existia
	// para um login de mentira; esta protege arquivos de verdade.
	if len(senha) < SenhaMinima {
		return nil, ErrSenhaCurta
	}
	hash, err := HashPassword(senha)
	if err != nil {
		return nil, err
	}
	nome := strings.ToLower(email[:strings.Index(email, "@")])

	var user User
	err = u.pool.QueryRow(ctx,
		`INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name`,
		email, nome, hash,
	).Scan(&user.ID, &user.Email, &user.Name)
	if err != nil {
		if strings.Contains(err.Error(), "users_email_lower_idx") {
			return nil, ErrEmailEmUso
		}
		return nil, fmt.Errorf("users: insert: %w", err)
	}
	return &user, nil
}

// Authenticate devolve `ErrSenhaInvalida` tanto para e-mail inexistente quanto
// para senha errada — de propósito: a mensagem não pode servir de oráculo de
// quem tem conta.
func (u *Users) Authenticate(ctx context.Context, email, senha string) (*User, error) {
	var user User
	var hash string
	err := u.pool.QueryRow(ctx,
		`SELECT id, email, name, password_hash FROM users WHERE lower(email) = lower($1)`,
		strings.TrimSpace(email),
	).Scan(&user.ID, &user.Email, &user.Name, &hash)
	if errors.Is(err, pgx.ErrNoRows) {
		// Gasta o mesmo tempo de um hash real, senão a diferença de latência
		// entrega quais e-mails existem.
		_ = VerifyPassword("$argon2id$v=19$m=65536,t=1,p=4$"+
			"c2FsdHNhbHRzYWx0c2E$Y2FmZWNhZmVjYWZlY2FmZWNhZmVjYWZlY2FmZWNhZmU", senha)
		return nil, ErrSenhaInvalida
	}
	if err != nil {
		return nil, fmt.Errorf("users: select: %w", err)
	}
	if !VerifyPassword(hash, senha) {
		return nil, ErrSenhaInvalida
	}
	return &user, nil
}

func (u *Users) ByID(ctx context.Context, id string) (*User, error) {
	var user User
	err := u.pool.QueryRow(ctx, `SELECT id, email, name FROM users WHERE id = $1`, id).
		Scan(&user.ID, &user.Email, &user.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNaoEncontrado
	}
	if err != nil {
		return nil, fmt.Errorf("users: byID: %w", err)
	}
	return &user, nil
}
