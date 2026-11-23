// Package admin guarda o que o ADMIN decide e o que ele precisa ver.
//
// São duas metades. A primeira é o que saiu do ConfigMap na migração 0012 —
// cadastro aberto, convites, planos — mais o histórico das decisões. A segunda
// são as leituras que cruzam tabelas (conta × faixas × ocupação × plano), que
// não cabem nos repositórios de cada domínio porque nenhum deles é dono do
// cruzamento.
//
// Nada aqui autentica ninguém: quem chama já passou por `exigirAdmin`.
package admin

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNaoEncontrado = errors.New("não encontrado")
	ErrInvalido      = errors.New("valor inválido")
	ErrJaExiste      = errors.New("já existe")
)

const (
	chaveCadastroAberto = "cadastro_aberto"
	chaveEnvImportado   = "env_importado"

	// O plano de toda conta que ninguém mudou (semeado na migração 0012).
	PlanoPadrao = "padrao"

	notaMaxima = 200
	nomeMaximo = 40
)

var (
	reEmail   = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
	rePlanoID = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)
)

type Painel struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Painel { return &Painel{pool: pool} }

// --- Cadastro aberto ------------------------------------------------------

// CadastroAberto diz se a plataforma aceita PEDIDOS de conta de quem não foi
// convidado. Sem a linha (banco novo, importação ainda não feita) é fechado —
// o estado mais restrito, como o padrão das colunas de `users`.
func (p *Painel) CadastroAberto(ctx context.Context) (bool, error) {
	var valor string
	err := p.pool.QueryRow(ctx, `SELECT valor FROM config WHERE chave = $1`, chaveCadastroAberto).Scan(&valor)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("admin: cadastro aberto: %w", err)
	}
	return valor == "true", nil
}

func (p *Painel) DefinirCadastroAberto(ctx context.Context, aberto bool) error {
	return gravarConfig(ctx, p.pool, chaveCadastroAberto, boolTexto(aberto))
}

func boolTexto(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// execer é o que `pgxpool.Pool` e `pgx.Tx` têm em comum: a importação do env
// roda dentro de uma transação e reusa a mesma escrita.
type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

func gravarConfig(ctx context.Context, q execer, chave, valor string) error {
	_, err := q.Exec(ctx, `
		INSERT INTO config (chave, valor) VALUES ($1, $2)
		ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()`,
		chave, valor)
	if err != nil {
		return fmt.Errorf("admin: gravar config: %w", err)
	}
	return nil
}

// --- Convites -------------------------------------------------------------

// Convite é um e-mail que o admin aprovou antes de a pessoa pedir conta.
type Convite struct {
	Email       string    `json:"email"`
	PodeEnviar  bool      `json:"podeEnviar"`
	RecebeDoBot bool      `json:"recebeDoBot"`
	Nota        string    `json:"nota,omitempty"`
	CriadoEm    time.Time `json:"criadoEm"`
}

func normalizarEmail(email string) (string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if !reEmail.MatchString(email) || len(email) > 254 {
		return "", ErrInvalido
	}
	return email, nil
}

// ConvitePara devolve o convite deste e-mail, ou `nil` se não há.
func (p *Painel) ConvitePara(ctx context.Context, email string) (*Convite, error) {
	var c Convite
	err := p.pool.QueryRow(ctx, `
		SELECT email, pode_enviar, recebe_do_bot, nota, criado_em
		  FROM convites WHERE email = lower(btrim($1))`, email).
		Scan(&c.Email, &c.PodeEnviar, &c.RecebeDoBot, &c.Nota, &c.CriadoEm)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("admin: convite: %w", err)
	}
	return &c, nil
}

func (p *Painel) Convites(ctx context.Context) ([]Convite, error) {
	linhas, err := p.pool.Query(ctx, `
		SELECT email, pode_enviar, recebe_do_bot, nota, criado_em
		  FROM convites ORDER BY criado_em, email`)
	if err != nil {
		return nil, fmt.Errorf("admin: convites: %w", err)
	}
	defer linhas.Close()

	saida := []Convite{}
	for linhas.Next() {
		var c Convite
		if err := linhas.Scan(&c.Email, &c.PodeEnviar, &c.RecebeDoBot, &c.Nota, &c.CriadoEm); err != nil {
			return nil, fmt.Errorf("admin: convites: scan: %w", err)
		}
		saida = append(saida, c)
	}
	return saida, linhas.Err()
}

// Convidar grava (ou regrava) o convite. `ErrJaExiste` quando o e-mail já tem
// conta: aí não há o que convidar, e o que o admin quer está na linha da conta.
func (p *Painel) Convidar(ctx context.Context, c Convite) (*Convite, error) {
	email, err := normalizarEmail(c.Email)
	if err != nil {
		return nil, err
	}
	nota := strings.TrimSpace(c.Nota)
	if utf8.RuneCountInString(nota) > notaMaxima {
		return nil, ErrInvalido
	}
	var existe bool
	if err := p.pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM users WHERE lower(email) = $1)`, email).Scan(&existe); err != nil {
		return nil, fmt.Errorf("admin: convidar: %w", err)
	}
	if existe {
		return nil, ErrJaExiste
	}
	var novo Convite
	err = p.pool.QueryRow(ctx, `
		INSERT INTO convites (email, pode_enviar, recebe_do_bot, nota) VALUES ($1, $2, $3, $4)
		ON CONFLICT (email) DO UPDATE
		   SET pode_enviar = EXCLUDED.pode_enviar,
		       recebe_do_bot = EXCLUDED.recebe_do_bot,
		       nota = EXCLUDED.nota
		RETURNING email, pode_enviar, recebe_do_bot, nota, criado_em`,
		email, c.PodeEnviar, c.RecebeDoBot, nota).
		Scan(&novo.Email, &novo.PodeEnviar, &novo.RecebeDoBot, &novo.Nota, &novo.CriadoEm)
	if err != nil {
		return nil, fmt.Errorf("admin: convidar: %w", err)
	}
	return &novo, nil
}

// RemoverConvite apaga o convite. É também como ele é CONSUMIDO no cadastro.
func (p *Painel) RemoverConvite(ctx context.Context, email string) (bool, error) {
	tag, err := p.pool.Exec(ctx, `DELETE FROM convites WHERE email = lower(btrim($1))`, email)
	if err != nil {
		return false, fmt.Errorf("admin: remover convite: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

// --- Planos ---------------------------------------------------------------

type Plano struct {
	ID        string    `json:"id"`
	Nome      string    `json:"nome"`
	CotaBytes int64     `json:"cotaBytes"`
	Contas    int       `json:"contas"`
	CriadoEm  time.Time `json:"criadoEm"`
}

func (p *Painel) Planos(ctx context.Context) ([]Plano, error) {
	linhas, err := p.pool.Query(ctx, `
		SELECT p.id, p.nome, p.cota_bytes, p.criado_em,
		       (SELECT count(*) FROM users u WHERE u.plano_id = p.id)
		  FROM planos p
		 ORDER BY p.cota_bytes, p.id`)
	if err != nil {
		return nil, fmt.Errorf("admin: planos: %w", err)
	}
	defer linhas.Close()

	saida := []Plano{}
	for linhas.Next() {
		var pl Plano
		if err := linhas.Scan(&pl.ID, &pl.Nome, &pl.CotaBytes, &pl.CriadoEm, &pl.Contas); err != nil {
			return nil, fmt.Errorf("admin: planos: scan: %w", err)
		}
		saida = append(saida, pl)
	}
	return saida, linhas.Err()
}

func validarPlano(nome string, cota int64) (string, error) {
	nome = strings.TrimSpace(nome)
	if nome == "" || utf8.RuneCountInString(nome) > nomeMaximo || cota < 0 {
		return "", ErrInvalido
	}
	return nome, nil
}

func (p *Painel) CriarPlano(ctx context.Context, id, nome string, cota int64) (*Plano, error) {
	id = strings.TrimSpace(id)
	if !rePlanoID.MatchString(id) {
		return nil, ErrInvalido
	}
	nome, err := validarPlano(nome, cota)
	if err != nil {
		return nil, err
	}
	pl := Plano{ID: id}
	err = p.pool.QueryRow(ctx, `
		INSERT INTO planos (id, nome, cota_bytes) VALUES ($1, $2, $3)
		ON CONFLICT (id) DO NOTHING
		RETURNING nome, cota_bytes, criado_em`, id, nome, cota).
		Scan(&pl.Nome, &pl.CotaBytes, &pl.CriadoEm)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrJaExiste
	}
	if err != nil {
		return nil, fmt.Errorf("admin: criar plano: %w", err)
	}
	return &pl, nil
}

// AtualizarPlano muda nome e/ou cota. `nil` é "não mexa".
func (p *Painel) AtualizarPlano(ctx context.Context, id string, nome *string, cota *int64) (*Plano, error) {
	if nome != nil {
		limpo := strings.TrimSpace(*nome)
		if limpo == "" || utf8.RuneCountInString(limpo) > nomeMaximo {
			return nil, ErrInvalido
		}
		nome = &limpo
	}
	if cota != nil && *cota < 0 {
		return nil, ErrInvalido
	}
	pl := Plano{ID: id}
	err := p.pool.QueryRow(ctx, `
		UPDATE planos SET nome = COALESCE($2, nome), cota_bytes = COALESCE($3, cota_bytes)
		 WHERE id = $1
		RETURNING nome, cota_bytes, criado_em,
		          (SELECT count(*) FROM users u WHERE u.plano_id = planos.id)`, id, nome, cota).
		Scan(&pl.Nome, &pl.CotaBytes, &pl.CriadoEm, &pl.Contas)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNaoEncontrado
	}
	if err != nil {
		return nil, fmt.Errorf("admin: atualizar plano: %w", err)
	}
	return &pl, nil
}

// --- Uso e cota -----------------------------------------------------------

// Uso é quanto uma conta ocupa e quanto ela tem.
//
// `CotaBytes` é a soma do plano com o extra avulso. Nesta versão o número só é
// MOSTRADO — nada recusa envio por causa dele. Quando recusar, os três pontos
// são: o pedido de vaga e a finalização do upload (`httpapi/upload.go`) e o
// worker depois de baixar uma URL (`worker.processar`), sempre contra a conta
// que vai ser DONA da faixa, não contra quem pediu.
type Uso struct {
	UsadoBytes int64 `json:"usadoBytes"`
	CotaBytes  int64 `json:"cotaBytes"`
}

func (p *Painel) UsoDaConta(ctx context.Context, userID string) (*Uso, error) {
	var u Uso
	err := p.pool.QueryRow(ctx, `
		SELECT coalesce((SELECT sum(size_bytes + art_bytes) FROM tracks WHERE user_id = u.id), 0),
		       pl.cota_bytes + u.cota_extra_bytes
		  FROM users u JOIN planos pl ON pl.id = u.plano_id
		 WHERE u.id = $1`, userID).Scan(&u.UsadoBytes, &u.CotaBytes)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNaoEncontrado
	}
	if err != nil {
		return nil, fmt.Errorf("admin: uso da conta: %w", err)
	}
	return &u, nil
}

// --- Contas ---------------------------------------------------------------

// Conta é a linha de `users` como o painel a mostra: o que `auth.Conta` já
// trazia (os nomes de campo são os mesmos, para a `ondasctl` continuar lendo),
// mais o que só existe cruzando com faixas, plano e atividade.
type Conta struct {
	ID         string     `json:"id"`
	Email      string     `json:"email"`
	Name       string     `json:"name"`
	Status     string     `json:"status"`
	PodeEnviar bool       `json:"podeEnviar"`
	Mensagem   string     `json:"mensagem,omitempty"`
	CriadaEm   time.Time  `json:"criadaEm"`
	DecididoEm *time.Time `json:"decididoEm,omitempty"`

	RecebeDoBot    bool   `json:"recebeDoBot"`
	PlanoID        string `json:"planoId"`
	PlanoNome      string `json:"planoNome"`
	CotaExtraBytes int64  `json:"cotaExtraBytes"`
	// Plano + extra.
	CotaBytes int64 `json:"cotaBytes"`
	Faixas    int   `json:"faixas"`
	// Áudio + capas das faixas de que a conta é DONA.
	UsadoBytes    int64      `json:"usadoBytes"`
	UltimoLoginEm *time.Time `json:"ultimoLoginEm,omitempty"`
	// Última vez que o marcador de reprodução andou — o mais perto que há de
	// "a pessoa usou o app".
	UltimaEscutaEm *time.Time `json:"ultimaEscutaEm,omitempty"`
}

const selecaoConta = `
	SELECT u.id, u.email, u.name, u.status, u.pode_enviar, coalesce(u.pedido_msg, ''),
	       u.created_at, u.decidido_em,
	       u.recebe_do_bot, u.plano_id, pl.nome, u.cota_extra_bytes,
	       pl.cota_bytes + u.cota_extra_bytes,
	       coalesce(t.faixas, 0), coalesce(t.bytes, 0),
	       u.ultimo_login_em,
	       (SELECT pb.updated_at FROM playback pb WHERE pb.user_id = u.id)
	  FROM users u
	  JOIN planos pl ON pl.id = u.plano_id
	  LEFT JOIN (SELECT user_id, count(*) AS faixas, sum(size_bytes + art_bytes) AS bytes
	               FROM tracks GROUP BY user_id) t ON t.user_id = u.id`

func lerConta(linha pgx.Row) (*Conta, error) {
	var c Conta
	if err := linha.Scan(&c.ID, &c.Email, &c.Name, &c.Status, &c.PodeEnviar, &c.Mensagem,
		&c.CriadaEm, &c.DecididoEm,
		&c.RecebeDoBot, &c.PlanoID, &c.PlanoNome, &c.CotaExtraBytes, &c.CotaBytes,
		&c.Faixas, &c.UsadoBytes, &c.UltimoLoginEm, &c.UltimaEscutaEm); err != nil {
		return nil, err
	}
	return &c, nil
}

// Contas lista para o painel, da mais antiga para a mais nova — a fila de
// pedidos é atendida na ordem em que chegou. Filtro vazio não filtra.
func (p *Painel) Contas(ctx context.Context, status, email string) ([]Conta, error) {
	linhas, err := p.pool.Query(ctx, selecaoConta+`
		 WHERE ($1 = '' OR u.status = $1)
		   AND ($2 = '' OR lower(u.email) = lower($2))
		 ORDER BY u.created_at, u.id`, status, strings.TrimSpace(email))
	if err != nil {
		return nil, fmt.Errorf("admin: contas: %w", err)
	}
	defer linhas.Close()

	saida := []Conta{}
	for linhas.Next() {
		c, err := lerConta(linhas)
		if err != nil {
			return nil, fmt.Errorf("admin: contas: scan: %w", err)
		}
		saida = append(saida, *c)
	}
	return saida, linhas.Err()
}

func (p *Painel) Conta(ctx context.Context, id string) (*Conta, error) {
	c, err := lerConta(p.pool.QueryRow(ctx, selecaoConta+` WHERE u.id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNaoEncontrado
	}
	if err != nil {
		return nil, fmt.Errorf("admin: conta: %w", err)
	}
	return c, nil
}

// Ajuste é o que o painel muda numa conta além do status. `nil` é "não mexa".
type Ajuste struct {
	PodeEnviar     *bool
	RecebeDoBot    *bool
	PlanoID        *string
	CotaExtraBytes *int64
}

func (a Ajuste) Vazio() bool {
	return a.PodeEnviar == nil && a.RecebeDoBot == nil && a.PlanoID == nil && a.CotaExtraBytes == nil
}

// AjustarConta aplica o ajuste num UPDATE só. `ErrInvalido` para plano que não
// existe ou extra negativo.
func (p *Painel) AjustarConta(ctx context.Context, id string, a Ajuste) (*Conta, error) {
	if a.CotaExtraBytes != nil && *a.CotaExtraBytes < 0 {
		return nil, ErrInvalido
	}
	if a.PlanoID != nil {
		var existe bool
		if err := p.pool.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM planos WHERE id = $1)`, *a.PlanoID).Scan(&existe); err != nil {
			return nil, fmt.Errorf("admin: ajustar conta: %w", err)
		}
		if !existe {
			return nil, ErrInvalido
		}
	}
	tag, err := p.pool.Exec(ctx, `
		UPDATE users SET
		    pode_enviar      = COALESCE($2, pode_enviar),
		    recebe_do_bot    = COALESCE($3, recebe_do_bot),
		    plano_id         = COALESCE($4, plano_id),
		    cota_extra_bytes = COALESCE($5, cota_extra_bytes)
		 WHERE id = $1`, id, a.PodeEnviar, a.RecebeDoBot, a.PlanoID, a.CotaExtraBytes)
	if err != nil {
		return nil, fmt.Errorf("admin: ajustar conta: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrNaoEncontrado
	}
	return p.Conta(ctx, id)
}

// --- Faixas ---------------------------------------------------------------

// Faixa é uma faixa do acervo como o painel a mostra: sem as keys do bucket,
// que não servem para decidir nada e são caminho de objeto privado.
type Faixa struct {
	ID           string    `json:"id"`
	Titulo       string    `json:"titulo"`
	Artista      string    `json:"artista"`
	DuracaoS     int       `json:"duracaoS"`
	Tipo         string    `json:"tipo"`
	AudioBytes   int64     `json:"audioBytes"`
	CapaBytes    int64     `json:"capaBytes"`
	Visibilidade string    `json:"visibilidade"`
	CriadaEm     time.Time `json:"criadaEm"`
	DonoID       string    `json:"donoId"`
	DonoEmail    string    `json:"donoEmail"`
	DonoNome     string    `json:"donoNome"`
}

const selecaoFaixa = `
	SELECT t.id, t.title, t.artist, t.duration_s, t.audio_type, t.size_bytes, t.art_bytes,
	       t.visibilidade, t.created_at, u.id, u.email, u.name
	  FROM tracks t JOIN users u ON u.id = t.user_id`

func lerFaixas(linhas pgx.Rows) ([]Faixa, error) {
	defer linhas.Close()
	saida := []Faixa{}
	for linhas.Next() {
		var f Faixa
		if err := linhas.Scan(&f.ID, &f.Titulo, &f.Artista, &f.DuracaoS, &f.Tipo, &f.AudioBytes,
			&f.CapaBytes, &f.Visibilidade, &f.CriadaEm, &f.DonoID, &f.DonoEmail, &f.DonoNome); err != nil {
			return nil, err
		}
		saida = append(saida, f)
	}
	return saida, linhas.Err()
}

// FaixasDaConta devolve as faixas de que a conta é dona, da mais nova para trás.
func (p *Painel) FaixasDaConta(ctx context.Context, userID string) ([]Faixa, error) {
	linhas, err := p.pool.Query(ctx, selecaoFaixa+`
		 WHERE t.user_id = $1 ORDER BY t.created_at DESC, t.id`, userID)
	if err != nil {
		return nil, fmt.Errorf("admin: faixas da conta: %w", err)
	}
	saida, err := lerFaixas(linhas)
	if err != nil {
		return nil, fmt.Errorf("admin: faixas da conta: %w", err)
	}
	return saida, nil
}

// Faixas lista o acervo inteiro. `ordem` é `tamanho` (as maiores primeiro) ou
// qualquer outra coisa (as mais novas primeiro).
func (p *Painel) Faixas(ctx context.Context, ordem string, limite int) ([]Faixa, error) {
	if limite <= 0 || limite > 500 {
		limite = 200
	}
	por := `t.created_at DESC, t.id`
	if ordem == "tamanho" {
		por = `(t.size_bytes + t.art_bytes) DESC, t.id`
	}
	linhas, err := p.pool.Query(ctx, selecaoFaixa+` ORDER BY `+por+` LIMIT $1`, limite)
	if err != nil {
		return nil, fmt.Errorf("admin: faixas: %w", err)
	}
	saida, err := lerFaixas(linhas)
	if err != nil {
		return nil, fmt.Errorf("admin: faixas: %w", err)
	}
	return saida, nil
}

// DonoDaFaixa devolve dono e título, que é o que o painel precisa para apagar
// pelo mesmo caminho do dono e para registrar o que foi apagado.
func (p *Painel) DonoDaFaixa(ctx context.Context, id string) (donoID, titulo string, err error) {
	err = p.pool.QueryRow(ctx, `SELECT user_id, title FROM tracks WHERE id = $1`, id).Scan(&donoID, &titulo)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", ErrNaoEncontrado
	}
	if err != nil {
		return "", "", fmt.Errorf("admin: dono da faixa: %w", err)
	}
	return donoID, titulo, nil
}

// --- Ingestões ------------------------------------------------------------

// Ingestao é um job da fila como o painel o mostra.
//
// `Fonte` sai resumida: de uma URL fica só o host (a URL inteira pode trazer
// token de acesso na query, e não há por que o painel repeti-la), e de um envio
// de arquivo fica a palavra `arquivo`.
type Ingestao struct {
	ID           string    `json:"id"`
	Status       string    `json:"status"`
	Tentativas   int       `json:"tentativas"`
	Erro         string    `json:"erro,omitempty"`
	Fonte        string    `json:"fonte"`
	Titulo       string    `json:"titulo,omitempty"`
	FaixaID      string    `json:"faixaId,omitempty"`
	PedidoPor    string    `json:"pedidoPor"`
	Destino      string    `json:"destino,omitempty"`
	CriadaEm     time.Time `json:"criadaEm"`
	AtualizadaEm time.Time `json:"atualizadaEm"`
}

func resumirFonte(fonte string) string {
	if strings.HasPrefix(fonte, "upload:") {
		return "arquivo"
	}
	resto := fonte
	if i := strings.Index(resto, "://"); i >= 0 {
		resto = resto[i+3:]
	}
	if i := strings.IndexAny(resto, "/?#"); i >= 0 {
		resto = resto[:i]
	}
	if i := strings.LastIndex(resto, "@"); i >= 0 {
		resto = resto[i+1:]
	}
	if resto == "" {
		return "url"
	}
	return resto
}

// Ingestoes lista os jobs, do mais recente para trás. `status` vazio = todos;
// `userID` vazio = de qualquer conta (como quem pediu OU como destino).
func (p *Painel) Ingestoes(ctx context.Context, status, userID string, limite int) ([]Ingestao, error) {
	if limite <= 0 || limite > 500 {
		limite = 100
	}
	linhas, err := p.pool.Query(ctx, `
		SELECT j.id, j.status, j.attempts, coalesce(j.error, ''), j.source_url,
		       coalesce(nullif(j.title, ''), j.fallback_title, ''), coalesce(j.track_id::text, ''),
		       u.email, coalesce(d.email, ''), j.created_at, j.updated_at
		  FROM ingest_jobs j
		  JOIN users u ON u.id = j.user_id
		  LEFT JOIN users d ON d.id = j.destino_id
		 WHERE ($1 = '' OR j.status = $1)
		   AND ($2 = '' OR j.user_id::text = $2 OR j.destino_id::text = $2)
		 ORDER BY j.created_at DESC, j.id
		 LIMIT $3`, status, userID, limite)
	if err != nil {
		return nil, fmt.Errorf("admin: ingestões: %w", err)
	}
	defer linhas.Close()

	saida := []Ingestao{}
	for linhas.Next() {
		var i Ingestao
		var fonte string
		if err := linhas.Scan(&i.ID, &i.Status, &i.Tentativas, &i.Erro, &fonte, &i.Titulo, &i.FaixaID,
			&i.PedidoPor, &i.Destino, &i.CriadaEm, &i.AtualizadaEm); err != nil {
			return nil, fmt.Errorf("admin: ingestões: scan: %w", err)
		}
		i.Fonte = resumirFonte(fonte)
		saida = append(saida, i)
	}
	return saida, linhas.Err()
}

// --- Resumo ---------------------------------------------------------------

// Resumo é a primeira tela: o tamanho de tudo, em poucos números.
type Resumo struct {
	Contas         map[string]int `json:"contas"`
	Faixas         int            `json:"faixas"`
	AudioBytes     int64          `json:"audioBytes"`
	CapaBytes      int64          `json:"capaBytes"`
	Ingestoes      map[string]int `json:"ingestoes"`
	Convites       int            `json:"convites"`
	CadastroAberto bool           `json:"cadastroAberto"`
	// Contas que já ocupam mais do que a cota delas.
	AcimaDaCota int `json:"acimaDaCota"`
}

func (p *Painel) Resumo(ctx context.Context) (*Resumo, error) {
	r := Resumo{
		Contas:    map[string]int{"pendente": 0, "aprovada": 0, "negada": 0},
		Ingestoes: map[string]int{"pending": 0, "processing": 0, "ready": 0, "error": 0},
	}
	contar := func(sql string, destino map[string]int) error {
		linhas, err := p.pool.Query(ctx, sql)
		if err != nil {
			return err
		}
		defer linhas.Close()
		for linhas.Next() {
			var chave string
			var n int
			if err := linhas.Scan(&chave, &n); err != nil {
				return err
			}
			destino[chave] = n
		}
		return linhas.Err()
	}
	if err := contar(`SELECT status, count(*) FROM users GROUP BY status`, r.Contas); err != nil {
		return nil, fmt.Errorf("admin: resumo: contas: %w", err)
	}
	if err := contar(`SELECT status, count(*) FROM ingest_jobs GROUP BY status`, r.Ingestoes); err != nil {
		return nil, fmt.Errorf("admin: resumo: ingestões: %w", err)
	}
	err := p.pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM tracks),
		       coalesce((SELECT sum(size_bytes) FROM tracks), 0),
		       coalesce((SELECT sum(art_bytes) FROM tracks), 0),
		       (SELECT count(*) FROM convites),
		       (SELECT count(*) FROM users u JOIN planos pl ON pl.id = u.plano_id
		         WHERE coalesce((SELECT sum(size_bytes + art_bytes) FROM tracks t WHERE t.user_id = u.id), 0)
		               > pl.cota_bytes + u.cota_extra_bytes)`).
		Scan(&r.Faixas, &r.AudioBytes, &r.CapaBytes, &r.Convites, &r.AcimaDaCota)
	if err != nil {
		return nil, fmt.Errorf("admin: resumo: %w", err)
	}
	if r.CadastroAberto, err = p.CadastroAberto(ctx); err != nil {
		return nil, err
	}
	return &r, nil
}

// --- Histórico ------------------------------------------------------------

// Evento é uma decisão do admin. `AlvoRotulo` é o e-mail ou o título COMO ERAM
// na hora: o registro de "conta apagada" tem de continuar legível depois que a
// conta não existe mais.
type Evento struct {
	ID         int64     `json:"id"`
	Em         time.Time `json:"em"`
	Acao       string    `json:"acao"`
	AlvoTipo   string    `json:"alvoTipo,omitempty"`
	AlvoID     string    `json:"alvoId,omitempty"`
	AlvoRotulo string    `json:"alvoRotulo,omitempty"`
	Detalhe    string    `json:"detalhe,omitempty"`
	IP         string    `json:"ip,omitempty"`
}

// Registrar grava o evento. Quem chama trata a falha como log, não como erro
// da operação: a decisão já valeu, e perder a linha do histórico não é motivo
// para dizer ao admin que ela não aconteceu.
func (p *Painel) Registrar(ctx context.Context, e Evento) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO admin_eventos (acao, alvo_tipo, alvo_id, alvo_rotulo, detalhe, ip)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		e.Acao, e.AlvoTipo, e.AlvoID, e.AlvoRotulo, e.Detalhe, e.IP)
	if err != nil {
		return fmt.Errorf("admin: registrar evento: %w", err)
	}
	return nil
}

func (p *Painel) Eventos(ctx context.Context, limite int) ([]Evento, error) {
	if limite <= 0 || limite > 500 {
		limite = 200
	}
	linhas, err := p.pool.Query(ctx, `
		SELECT id, em, acao, alvo_tipo, alvo_id, alvo_rotulo, detalhe, ip
		  FROM admin_eventos ORDER BY em DESC, id DESC LIMIT $1`, limite)
	if err != nil {
		return nil, fmt.Errorf("admin: eventos: %w", err)
	}
	defer linhas.Close()

	saida := []Evento{}
	for linhas.Next() {
		var e Evento
		if err := linhas.Scan(&e.ID, &e.Em, &e.Acao, &e.AlvoTipo, &e.AlvoID, &e.AlvoRotulo,
			&e.Detalhe, &e.IP); err != nil {
			return nil, fmt.Errorf("admin: eventos: scan: %w", err)
		}
		saida = append(saida, e)
	}
	return saida, linhas.Err()
}
