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
	Name  string `json:"name"`
	// O catálogo público entra na lista desta conta ou não (migração 0005).
	//
	// Sai em TODA resposta de auth — /login, /signup e /me — porque a PWA
	// decide a fonte do catálogo no boot, antes de qualquer outra chamada.
	// Do lado de lá o campo é opcional e `undefined` vale `true`, para o
	// espelho local gravado por uma versão antiga não significar "desligado"
	// (ver `showsPublicCatalog` em core).
	Publico bool `json:"publico"`
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
		`INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)
		  RETURNING id, email, name, publico`,
		email, nome, hash,
	).Scan(&user.ID, &user.Email, &user.Name, &user.Publico)
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
		`SELECT id, email, name, publico, password_hash FROM users WHERE lower(email) = lower($1)`,
		strings.TrimSpace(email),
	).Scan(&user.ID, &user.Email, &user.Name, &user.Publico, &hash)
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
	err := u.pool.QueryRow(ctx, `SELECT id, email, name, publico FROM users WHERE id = $1`, id).
		Scan(&user.ID, &user.Email, &user.Name, &user.Publico)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNaoEncontrado
	}
	if err != nil {
		return nil, fmt.Errorf("users: byID: %w", err)
	}
	return &user, nil
}

// NomesPorIDs devolve o nome de exibição de cada id, na ordem em que foram
// pedidos, pulando quem não existir mais.
//
// Serve à resposta de compartilhamento, que fala em NOME e não em e-mail: quem
// compartilhou já sabe para quem mandou, e a resposta não precisa devolver o
// e-mail de ninguém pela rede.
//
// Uma consulta só, e não uma por id: a lista cabe em 32 (`maxDestinatarios`) e
// um laço de queries aqui seria 32 idas ao banco para montar um JSON.
func (u *Users) NomesPorIDs(ctx context.Context, ids []string) ([]string, error) {
	// `[]string{}` e nunca `nil`: quem serializa quer `[]` no JSON.
	nomes := []string{}
	if len(ids) == 0 {
		return nomes, nil
	}
	linhas, err := u.pool.Query(ctx, `
		SELECT u.name FROM unnest($1::uuid[]) WITH ORDINALITY AS pedido(id, ord)
		  JOIN users u ON u.id = pedido.id
		 ORDER BY pedido.ord`, ids)
	if err != nil {
		return nil, fmt.Errorf("users: nomesPorIDs: %w", err)
	}
	defer linhas.Close()

	for linhas.Next() {
		var nome string
		if err := linhas.Scan(&nome); err != nil {
			return nil, fmt.Errorf("users: nomesPorIDs: scan: %w", err)
		}
		nomes = append(nomes, nome)
	}
	if err := linhas.Err(); err != nil {
		return nil, fmt.Errorf("users: nomesPorIDs: %w", err)
	}
	return nomes, nil
}

// PorEmail resolve o dono configurado para a ingestão por token (o bot não tem
// sessão, então é o e-mail do ConfigMap que diz de quem é a faixa).
func (u *Users) PorEmail(ctx context.Context, email string) (*User, error) {
	var user User
	err := u.pool.QueryRow(ctx,
		`SELECT id, email, name, publico FROM users WHERE lower(email) = lower($1)`, email).
		Scan(&user.ID, &user.Email, &user.Name, &user.Publico)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNaoEncontrado
	}
	if err != nil {
		return nil, fmt.Errorf("users: porEmail: %w", err)
	}
	return &user, nil
}

// DefinirPublico liga ou desliga o catálogo público desta conta.
//
// Devolve o usuário já atualizado em vez de só `error`: quem chama responde o
// `User` novo, e assim não há uma segunda leitura que possa discordar da
// escrita.
func (u *Users) DefinirPublico(ctx context.Context, id string, on bool) (*User, error) {
	var user User
	err := u.pool.QueryRow(ctx,
		`UPDATE users SET publico = $2 WHERE id = $1 RETURNING id, email, name, publico`,
		id, on,
	).Scan(&user.ID, &user.Email, &user.Name, &user.Publico)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNaoEncontrado
	}
	if err != nil {
		return nil, fmt.Errorf("users: definirPublico: %w", err)
	}
	return &user, nil
}
