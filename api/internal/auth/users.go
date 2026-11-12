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
	// A aparência que segue a conta (migração 0010).
	//
	// Valor e não ponteiro, para o JSON trazer `"prefs": {}` mesmo quando a
	// conta nunca escolheu nada: é a PRESENÇA da chave que diz à PWA que este
	// servidor sabe guardar preferências. Sem ela o cliente não manda nenhuma
	// (um servidor antigo responderia 400 ao campo que não conhece).
	Prefs Prefs `json:"prefs"`
}

// Prefs são as preferências de aparência da conta.
//
// Todo campo é ponteiro, e `nil` tem um sentido em cada direção: na resposta é
// "a conta nunca escolheu" (a coluna é NULL, e o campo some do JSON); no pedido
// é "não mexa neste". É o que deixa o PATCH ser parcial — trocar o tema num
// aparelho não desfaz o idioma trocado em outro.
type Prefs struct {
	Tema    *string  `json:"tema,omitempty"`
	Idioma  *string  `json:"idioma,omitempty"`
	Opacity *float64 `json:"opacity,omitempty"`
	Blur    *int16   `json:"blur,omitempty"`
	Wall    *string  `json:"wall,omitempty"`
}

// Vazio diz se o pedido não traz preferência nenhuma.
func (p Prefs) Vazio() bool {
	return p.Tema == nil && p.Idioma == nil && p.Opacity == nil && p.Blur == nil && p.Wall == nil
}

// colunasUser é o que toda leitura de `users` traz, na ordem em que `lerUser`
// lê. Eram cinco consultas repetindo a lista; com as preferências ela dobrou de
// tamanho, e uma coluna esquecida em uma delas seria um `/login` que devolve
// preferência vazia para uma conta que tem.
const colunasUser = `id, email, name, publico,
	pref_tema, pref_idioma, pref_opacity, pref_blur, pref_wall`

// lerUser lê uma linha de `colunasUser`. `extras` são colunas a mais que a
// consulta pediu DEPOIS delas — o `password_hash` de `Authenticate`.
func lerUser(linha pgx.Row, extras ...any) (*User, error) {
	var user User
	destinos := append([]any{
		&user.ID, &user.Email, &user.Name, &user.Publico,
		&user.Prefs.Tema, &user.Prefs.Idioma, &user.Prefs.Opacity, &user.Prefs.Blur, &user.Prefs.Wall,
	}, extras...)
	if err := linha.Scan(destinos...); err != nil {
		return nil, err
	}
	return &user, nil
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

	user, err := lerUser(u.pool.QueryRow(ctx,
		`INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)
		  RETURNING `+colunasUser,
		email, nome, hash,
	))
	if err != nil {
		if strings.Contains(err.Error(), "users_email_lower_idx") {
			return nil, ErrEmailEmUso
		}
		return nil, fmt.Errorf("users: insert: %w", err)
	}
	return user, nil
}

// Authenticate devolve `ErrSenhaInvalida` tanto para e-mail inexistente quanto
// para senha errada — de propósito: a mensagem não pode servir de oráculo de
// quem tem conta.
func (u *Users) Authenticate(ctx context.Context, email, senha string) (*User, error) {
	var hash string
	user, err := lerUser(u.pool.QueryRow(ctx,
		`SELECT `+colunasUser+`, password_hash FROM users WHERE lower(email) = lower($1)`,
		strings.TrimSpace(email),
	), &hash)
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
	return user, nil
}

func (u *Users) ByID(ctx context.Context, id string) (*User, error) {
	user, err := lerUser(u.pool.QueryRow(ctx, `SELECT `+colunasUser+` FROM users WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNaoEncontrado
	}
	if err != nil {
		return nil, fmt.Errorf("users: byID: %w", err)
	}
	return user, nil
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
	user, err := lerUser(u.pool.QueryRow(ctx,
		`SELECT `+colunasUser+` FROM users WHERE lower(email) = lower($1)`, email))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNaoEncontrado
	}
	if err != nil {
		return nil, fmt.Errorf("users: porEmail: %w", err)
	}
	return user, nil
}

// AtualizarPrefs muda as preferências da conta: `publico`, a aparência, ou as
// duas coisas.
//
// PARCIAL por construção: `nil` é "não mexa", e o `COALESCE` deixa a coluna
// como estava. É um UPDATE só, então não há janela em que metade do pedido
// valeu — e dois aparelhos mudando campos diferentes ao mesmo tempo não se
// atropelam, que é a única regra de conflito que as preferências têm.
//
// O que ele NÃO sabe fazer é voltar um campo para "nunca escolhi": `nil` já
// tem outro sentido. Não faz falta — a tela só oferece trocar por outro valor.
//
// Devolve o usuário já atualizado em vez de só `error`: quem chama responde o
// `User` novo, e assim não há uma segunda leitura que possa discordar da
// escrita.
//
// Não valida nada: a peneira é do handler (`validarPrefs`), e os CHECKs da
// migração 0010 são a rede por baixo dele.
func (u *Users) AtualizarPrefs(ctx context.Context, id string, publico *bool, p Prefs) (*User, error) {
	user, err := lerUser(u.pool.QueryRow(ctx,
		`UPDATE users SET
		    publico      = COALESCE($2, publico),
		    pref_tema    = COALESCE($3, pref_tema),
		    pref_idioma  = COALESCE($4, pref_idioma),
		    pref_opacity = COALESCE($5, pref_opacity),
		    pref_blur    = COALESCE($6, pref_blur),
		    pref_wall    = COALESCE($7, pref_wall)
		  WHERE id = $1 RETURNING `+colunasUser,
		id, publico, p.Tema, p.Idioma, p.Opacity, p.Blur, p.Wall,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNaoEncontrado
	}
	if err != nil {
		return nil, fmt.Errorf("users: atualizarPrefs: %w", err)
	}
	return user, nil
}
