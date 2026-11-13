package auth

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

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
	ErrNomeInvalido  = errors.New("nome inválido")
	ErrMensagemLonga = fmt.Errorf("mensagem com mais de %d caracteres", MensagemMaxima)
)

// Os três estados de uma conta (migração 0011). Só `StatusAprovada` entra.
const (
	StatusPendente = "pendente"
	StatusAprovada = "aprovada"
	StatusNegada   = "negada"
)

// StatusValido diz se o texto é um dos três estados — a peneira do filtro da
// listagem do admin, que chega por query string.
func StatusValido(s string) bool {
	return s == StatusPendente || s == StatusAprovada || s == StatusNegada
}

const (
	// O nome aparece no rodapé e no prompt da PWA; passou disso ele quebra a
	// linha em tela de celular.
	NomeMaximo = 40
	// O mesmo teto do CHECK `users_pedido_msg_ck`.
	MensagemMaxima = 500
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
	// Em análise, aprovada ou negada (migração 0011).
	//
	// Fora do JSON: quem recebe um `User` já está, por definição, aprovado — o
	// login e o middleware de sessão recusam os outros dois antes de responder.
	Status string `json:"-"`
	// Esta conta pode entrar com faixa nova (enviar arquivo, pedir ingestão)?
	//
	// Sai em toda resposta de auth para a PWA esconder o painel de envio de
	// quem não pode usá-lo. É só cortesia de tela: quem recusa de verdade é
	// `exigirEnvio`, no servidor.
	PodeEnviar bool `json:"podeEnviar"`
}

// Conta é a linha de `users` como o ADMIN a vê.
//
// Separada de `User` porque as duas respostas têm públicos opostos: `User` vai
// para o próprio dono, pelo navegador, e por isso esconde id e e-mail; `Conta`
// só sai nas rotas de `/api/admin`, e o admin precisa justamente do e-mail e da
// mensagem para decidir.
type Conta struct {
	ID         string     `json:"id"`
	Email      string     `json:"email"`
	Name       string     `json:"name"`
	Status     string     `json:"status"`
	PodeEnviar bool       `json:"podeEnviar"`
	Mensagem   string     `json:"mensagem,omitempty"`
	CriadaEm   time.Time  `json:"criadaEm"`
	DecididoEm *time.Time `json:"decididoEm,omitempty"`
}

const colunasConta = `id, email, name, status, pode_enviar, coalesce(pedido_msg, ''),
	created_at, decidido_em`

func lerConta(linha pgx.Row) (*Conta, error) {
	var c Conta
	if err := linha.Scan(&c.ID, &c.Email, &c.Name, &c.Status, &c.PodeEnviar, &c.Mensagem,
		&c.CriadaEm, &c.DecididoEm); err != nil {
		return nil, err
	}
	return &c, nil
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
	pref_tema, pref_idioma, pref_opacity, pref_blur, pref_wall,
	status, pode_enviar`

// lerUser lê uma linha de `colunasUser`. `extras` são colunas a mais que a
// consulta pediu DEPOIS delas — o `password_hash` de `Authenticate`.
func lerUser(linha pgx.Row, extras ...any) (*User, error) {
	var user User
	destinos := append([]any{
		&user.ID, &user.Email, &user.Name, &user.Publico,
		&user.Prefs.Tema, &user.Prefs.Idioma, &user.Prefs.Opacity, &user.Prefs.Blur, &user.Prefs.Wall,
		&user.Status, &user.PodeEnviar,
	}, extras...)
	if err := linha.Scan(destinos...); err != nil {
		return nil, err
	}
	return &user, nil
}

type Users struct{ pool *pgxpool.Pool }

func NewUsers(pool *pgxpool.Pool) *Users { return &Users{pool: pool} }

// Nova é um pedido de conta.
type Nova struct {
	Email string
	Senha string
	// Vazio = a parte do e-mail antes do `@`, como sempre foi.
	Nome string
	// O que a pessoa quis dizer ao admin. Opcional.
	Mensagem string
	// `StatusPendente` para o pedido comum; `StatusAprovada` para quem está na
	// allowlist, que o operador já decidiu de antemão.
	Status string
}

// normalizarNome apara e confere o nome de exibição.
//
// Recusa caractere de controle, e não só o tamanho: o nome é desenhado numa
// linha de terminal, e uma quebra de linha ali desmonta o rodapé.
func normalizarNome(nome string) (string, error) {
	nome = strings.TrimSpace(nome)
	if nome == "" || utf8.RuneCountInString(nome) > NomeMaximo {
		return "", ErrNomeInvalido
	}
	for _, r := range nome {
		if unicode.IsControl(r) {
			return "", ErrNomeInvalido
		}
	}
	return nome, nil
}

// Create grava a conta no estado pedido. `pode_enviar` nasce sempre `false`
// (o padrão da coluna): liberar envio é decisão à parte, do admin.
func (u *Users) Create(ctx context.Context, n Nova) (*User, error) {
	email := strings.TrimSpace(n.Email)
	if !reEmail.MatchString(email) {
		return nil, ErrEmailInvalido
	}
	// A senha mínima aqui é maior que a do protótipo (4): aquela regra existia
	// para um login de mentira; esta protege arquivos de verdade.
	if len(n.Senha) < SenhaMinima {
		return nil, ErrSenhaCurta
	}
	nome := strings.ToLower(email[:strings.Index(email, "@")])
	if strings.TrimSpace(n.Nome) != "" {
		var err error
		if nome, err = normalizarNome(n.Nome); err != nil {
			return nil, err
		}
	} else if utf8.RuneCountInString(nome) > NomeMaximo {
		nome = string([]rune(nome)[:NomeMaximo])
	}
	mensagem := strings.TrimSpace(n.Mensagem)
	if utf8.RuneCountInString(mensagem) > MensagemMaxima {
		return nil, ErrMensagemLonga
	}
	status := n.Status
	if status == "" {
		status = StatusPendente
	}
	hash, err := HashPassword(n.Senha)
	if err != nil {
		return nil, err
	}

	// Quem já nasce aprovado (allowlist) também ganha a data da decisão: ela
	// foi tomada quando o operador escreveu o e-mail na lista.
	user, err := lerUser(u.pool.QueryRow(ctx,
		`INSERT INTO users (email, name, password_hash, status, pedido_msg, decidido_em)
		 VALUES ($1, $2, $3, $4, nullif($5, ''), CASE WHEN $4 = 'pendente' THEN NULL ELSE now() END)
		  RETURNING `+colunasUser,
		email, nome, hash, status, mensagem,
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

// Renomear troca o nome de exibição da conta.
func (u *Users) Renomear(ctx context.Context, id, nome string) (*User, error) {
	nome, err := normalizarNome(nome)
	if err != nil {
		return nil, err
	}
	user, err := lerUser(u.pool.QueryRow(ctx,
		`UPDATE users SET name = $2 WHERE id = $1 RETURNING `+colunasUser, id, nome))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNaoEncontrado
	}
	if err != nil {
		return nil, fmt.Errorf("users: renomear: %w", err)
	}
	return user, nil
}

// ConferirSenha diz se esta é a senha da conta. `ErrSenhaInvalida` quando não é.
//
// É a segunda prova que as ações sem volta pedem (trocar a senha, apagar a
// conta): o cookie diz que este navegador entrou um dia, e a senha diz que quem
// está na frente dele agora é a pessoa.
func (u *Users) ConferirSenha(ctx context.Context, id, senha string) error {
	var hash string
	err := u.pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE id = $1`, id).Scan(&hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNaoEncontrado
	}
	if err != nil {
		return fmt.Errorf("users: conferirSenha: %w", err)
	}
	if !VerifyPassword(hash, senha) {
		return ErrSenhaInvalida
	}
	return nil
}

// TrocarSenha grava a senha nova, depois de conferir a atual.
//
// NÃO derruba as sessões abertas em outros aparelhos: o cookie é assinado e
// sem estado (ver session.go), então não há o que revogar por conta. O botão
// que existe é o global, trocar `SESSION_SECRET`.
func (u *Users) TrocarSenha(ctx context.Context, id, atual, nova string) error {
	if len(nova) < SenhaMinima {
		return ErrSenhaCurta
	}
	if err := u.ConferirSenha(ctx, id, atual); err != nil {
		return err
	}
	hash, err := HashPassword(nova)
	if err != nil {
		return err
	}
	if _, err := u.pool.Exec(ctx, `UPDATE users SET password_hash = $2 WHERE id = $1`, id, hash); err != nil {
		return fmt.Errorf("users: trocarSenha: %w", err)
	}
	return nil
}

// Apagar remove a conta. Curtidas, playlists, histórico, faixas e
// compartilhamentos vão junto pelo `ON DELETE CASCADE` de cada tabela — o que
// o banco NÃO alcança são os objetos no R2, e por isso quem chama apaga as
// faixas antes (ver `apagarConta`, no httpapi).
func (u *Users) Apagar(ctx context.Context, id string) error {
	if _, err := u.pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, id); err != nil {
		return fmt.Errorf("users: apagar: %w", err)
	}
	return nil
}

// Filtro recorta a listagem do admin. Campo vazio não filtra.
type Filtro struct {
	Status string
	Email  string
}

// Listar devolve as contas para o admin, da mais antiga para a mais nova: a
// fila de pedidos é atendida na ordem em que chegou.
func (u *Users) Listar(ctx context.Context, f Filtro) ([]Conta, error) {
	linhas, err := u.pool.Query(ctx,
		`SELECT `+colunasConta+` FROM users
		  WHERE ($1 = '' OR status = $1)
		    AND ($2 = '' OR lower(email) = lower($2))
		  ORDER BY created_at, id`,
		f.Status, strings.TrimSpace(f.Email))
	if err != nil {
		return nil, fmt.Errorf("users: listar: %w", err)
	}
	defer linhas.Close()

	// `[]Conta{}` e nunca `nil`: quem serializa quer `[]` no JSON.
	contas := []Conta{}
	for linhas.Next() {
		c, err := lerConta(linhas)
		if err != nil {
			return nil, fmt.Errorf("users: listar: scan: %w", err)
		}
		contas = append(contas, *c)
	}
	if err := linhas.Err(); err != nil {
		return nil, fmt.Errorf("users: listar: %w", err)
	}
	return contas, nil
}

// Decidir aprova ou nega uma conta.
//
// Vale também para voltar atrás: aprovar quem foi negado, e negar quem já
// estava aprovado — que é como se suspende uma conta. O efeito é imediato,
// porque `exigirSessao` relê o status a cada pedido.
func (u *Users) Decidir(ctx context.Context, id, status string) (*Conta, error) {
	c, err := lerConta(u.pool.QueryRow(ctx,
		`UPDATE users SET status = $2, decidido_em = now() WHERE id = $1 RETURNING `+colunasConta,
		id, status))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNaoEncontrado
	}
	if err != nil {
		return nil, fmt.Errorf("users: decidir: %w", err)
	}
	return c, nil
}

// DefinirEnvio liga ou desliga o direito de entrar com faixa nova.
func (u *Users) DefinirEnvio(ctx context.Context, id string, pode bool) (*Conta, error) {
	c, err := lerConta(u.pool.QueryRow(ctx,
		`UPDATE users SET pode_enviar = $2 WHERE id = $1 RETURNING `+colunasConta, id, pode))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNaoEncontrado
	}
	if err != nil {
		return nil, fmt.Errorf("users: definirEnvio: %w", err)
	}
	return c, nil
}
