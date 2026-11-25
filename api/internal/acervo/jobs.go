package acervo

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrJobNaoEncontrado = errors.New("ingestão não encontrada")
	ErrFilaVazia        = errors.New("fila vazia")
)

// Depois disto o job desiste. Três porque as falhas que se repetem aqui são
// quase sempre permanentes (URL morta, formato que não toca); as temporárias
// (rede piscando) costumam passar na segunda.
const MaxTentativas = 3

// --- Fonte do job ---------------------------------------------------------

// prefixoUpload marca um job cuja mídia JÁ ESTÁ no bucket, gravada por um
// cliente autenticado com URL assinada, em vez de ser baixada de uma URL
// pública. Os dois clientes são a tela de envio da PWA e o node do Hermes.
//
// Guardamos só o id do envio, nunca a key: o worker reconstrói a key com o
// `user_id` do próprio job (ver storage.KeyUploadStage). Assim a fonte
// guardada no banco não é um caminho que o worker obedece — é um identificador
// que ele valida contra o dono.
const prefixoUpload = "upload:"

// FonteUpload monta o valor de `source_url` de um envio de arquivo.
func FonteUpload(uploadID string) string { return prefixoUpload + uploadID }

// IDDoUpload devolve o id do envio quando a fonte é um upload. É o que faz o
// worker escolher entre ler do bucket e baixar da internet.
func IDDoUpload(fonte string) (string, bool) {
	id, ok := strings.CutPrefix(fonte, prefixoUpload)
	return id, ok && id != ""
}

// Tempo após o qual um job travado em `processing` volta para a fila — é o
// worker que morreu no meio, não um trabalho em andamento.
const PrazoTravado = 15 * time.Minute

type Job struct {
	ID        string
	UserID    string
	SourceURL string
	Title     string
	Artist    string
	// TituloReserva é o nome do arquivo que o cliente enviou: perde das tags
	// do arquivo e ganha do "sem título" (ver migração 0003). É o que faz as
	// tags que o scdl escreve ganharem do nome do arquivo que ele gerou.
	TituloReserva string
	Status        string
	Attempts      int
	Error         string
	TrackID       string
	// Conta que vai ser DONA da faixa quando o job terminar. Vazio = o próprio
	// `UserID`.
	//
	// Os dois não são a mesma coisa e não podem ser unificados: `UserID` é quem
	// PEDIU, e é ele que reconstrói a key da área de espera no R2
	// (`storage.KeyUploadStage`) e que deixa o bot ler o status do próprio job.
	DestinoID    string
	Visibilidade string
	// QUEM atende o job (migração 0013): `midia` é do worker do cluster,
	// `pagina` é do node do Hermes — que baixa o link e devolve o job como
	// `midia`, com a fonte trocada por um arquivo enviado.
	Tipo string
	// O link de página como a pessoa mandou, já canonizado. Sobrevive à troca
	// de `SourceURL`, para o status continuar mostrando o que ela reconhece.
	PaginaURL string
	CreatedAt time.Time
	UpdatedAt time.Time
}

const (
	TipoMidia  = "midia"
	TipoPagina = "pagina"
)

// Quantos pedidos uma conta pode ter em andamento pela PWA. A rota de
// ingestão não tem outro freio, e cada job de página é um download no node.
//
// Cinco e não três: a mesma URL publicada para "só eu", duas pessoas e "todos"
// são quatro pedidos legítimos de uma vez (ver o índice de dedupe da 0007).
const MaxAtivosPorConta = 5

// Destino é para onde a faixa vai quando o job terminar.
//
// Existe como struct, e não como dois parâmetros a mais em `Enfileirar`, pelo
// mesmo motivo de `Nova`: a assinatura já tinha cinco strings seguidas, e duas
// trocadas de lugar entre si compilariam sem reclamar.
type Destino struct {
	// Conta que recebe a faixa. Vazio = quem pediu.
	UserID string
	// `privada` ou `todos`. Vazio = `privada`, pelo DEFAULT da coluna.
	Visibilidade string
}

type Jobs struct{ pool *pgxpool.Pool }

func NewJobs(pool *pgxpool.Pool) *Jobs { return &Jobs{pool: pool} }

const colunasJob = `id, user_id, source_url, coalesce(title, ''), coalesce(artist, ''),
	coalesce(fallback_title, ''), status, attempts, coalesce(error, ''),
	coalesce(track_id::text, ''), coalesce(destino_id::text, ''), visibilidade,
	tipo, coalesce(pagina_url, ''),
	created_at, updated_at`

func scanJob(row pgx.Row) (*Job, error) {
	var j Job
	err := row.Scan(&j.ID, &j.UserID, &j.SourceURL, &j.Title, &j.Artist,
		&j.TituloReserva, &j.Status, &j.Attempts, &j.Error, &j.TrackID,
		&j.DestinoID, &j.Visibilidade,
		&j.Tipo, &j.PaginaURL,
		&j.CreatedAt, &j.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrJobNaoEncontrado
	}
	if err != nil {
		return nil, err
	}
	return &j, nil
}

// Enfileirar cria o job — ou devolve o que já existe para a mesma URL.
//
// `novo` diz qual dos dois aconteceu, para o handler responder 202 ou 200. O
// pedido repetido é esperado: o bot reenvia quando o usuário toca no botão de
// novo ou quando o Telegram repete a entrega.
func (r *Jobs) Enfileirar(ctx context.Context, userID, url, title, artist string, d Destino) (job *Job, novo bool, err error) {
	return r.enfileirar(ctx, userID, url, title, artist, "", TipoMidia, d)
}

// EnfileirarPagina cria o job de um link de PÁGINA (YouTube, SoundCloud), que
// quem atende é o node. `url` já vem canonizada (`ingest.ClassificarLink`), e é
// por isso que o mesmo vídeo colado de dois jeitos cai no mesmo job.
//
// Sem destino: pela PWA a faixa é sempre de quem pediu.
func (r *Jobs) EnfileirarPagina(ctx context.Context, userID, url string) (job *Job, novo bool, err error) {
	return r.enfileirar(ctx, userID, url, "", "", "", TipoPagina, Destino{})
}

// EnfileirarEnvio é o Enfileirar de um envio de arquivo: além do título escolhido,
// guarda um título de RESERVA — o nome do arquivo — que só é usado se o
// arquivo não tiver tag nenhuma. Método irmão em vez de um parâmetro a mais
// porque o caminho do bot não tem nome de arquivo para informar.
func (r *Jobs) EnfileirarEnvio(ctx context.Context, userID, fonte, title, artist, reserva string, d Destino) (job *Job, novo bool, err error) {
	return r.enfileirar(ctx, userID, fonte, title, artist, reserva, TipoMidia, d)
}

func (r *Jobs) enfileirar(ctx context.Context, userID, url, title, artist, reserva, tipo string, d Destino) (job *Job, novo bool, err error) {
	var t, a *string
	if title != "" {
		t = &title
	}
	if artist != "" {
		a = &artist
	}
	// Vazio tem de virar NULL, e não `''`: a coluna é `uuid` e referencia
	// `users`.
	var destino *string
	if d.UserID != "" {
		destino = &d.UserID
	}
	vis := d.Visibilidade
	if vis == "" {
		vis = VisibilidadePrivada
	}
	// ON CONFLICT no índice parcial de jobs ativos: sem DO UPDATE, porque
	// reenviar não deve mexer no que já está sendo processado.
	//
	// OS QUATRO CAMPOS DO CONFLITO TÊM DE SER OS MESMOS DO ÍNDICE da migração
	// 0007, `coalesce` incluído, senão o Postgres não acha índice nenhum para
	// o conflito e o INSERT falha. O destino entra nele porque a mesma URL para
	// duas pessoas diferentes são dois pedidos legítimos.
	j, err := scanJob(r.pool.QueryRow(ctx, `
		INSERT INTO ingest_jobs (user_id, source_url, title, artist, fallback_title,
		                         destino_id, visibilidade, tipo, pagina_url)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $8 = 'pagina' THEN $2 END)
		ON CONFLICT (user_id, source_url, coalesce(destino_id, user_id), visibilidade)
		WHERE status IN ('pending', 'processing')
		DO NOTHING
		RETURNING `+colunasJob, userID, url, t, a, reserva, destino, vis, tipo))
	if err == nil {
		return j, true, nil
	}
	if !errors.Is(err, ErrJobNaoEncontrado) {
		return nil, false, err
	}
	// DO NOTHING não devolve linha: o job ativo já existia. A busca tem de
	// repetir o MESMO critério do índice — sem o destino aqui, o pedido para a
	// segunda pessoa devolveria o job da primeira.
	//
	// E ela é a segunda tranca: medido falsificando o índice da 0007 para a
	// forma antiga, o pedido para o segundo destino não devolve o job errado em
	// silêncio — ele não acha nada e vira erro. Um índice que um dia perca o
	// destino falha alto em vez de entregar música para a pessoa errada.
	j, err = scanJob(r.pool.QueryRow(ctx, `
		SELECT `+colunasJob+` FROM ingest_jobs
		WHERE user_id = $1 AND source_url = $2
		  AND coalesce(destino_id, user_id) = coalesce($3::uuid, user_id)
		  AND visibilidade = $4
		  AND status IN ('pending', 'processing')`,
		userID, url, destino, vis))
	if err != nil {
		return nil, false, err
	}
	return j, false, nil
}

// PaginaAtiva devolve o pedido EM ANDAMENTO desta conta para este link de
// página, se houver.
//
// O índice `ingest_jobs_ativo_idx` segura a repetição pelo `source_url`, e
// deixa de segurar no instante em que o node entrega o arquivo: `EntregarPagina`
// troca a fonte por `upload:<id>`. Colar o mesmo link nessa janela criava um
// segundo job — e, antes da 0014, uma segunda faixa. `pagina_url` não muda.
func (r *Jobs) PaginaAtiva(ctx context.Context, userID, paginaURL string) (*Job, error) {
	return scanJob(r.pool.QueryRow(ctx, `
		SELECT `+colunasJob+` FROM ingest_jobs
		 WHERE user_id = $1 AND pagina_url = $2
		   AND status IN ('pending', 'processing')
		 ORDER BY created_at
		 LIMIT 1`, userID, paginaURL))
}

func (r *Jobs) PorID(ctx context.Context, userID, id string) (*Job, error) {
	return scanJob(r.pool.QueryRow(ctx,
		`SELECT `+colunasJob+` FROM ingest_jobs WHERE id = $1 AND user_id = $2`, id, userID))
}

// Ativos conta os pedidos da conta que ainda não terminaram.
func (r *Jobs) Ativos(ctx context.Context, userID string) (int, error) {
	var n int
	err := r.pool.QueryRow(ctx, `
		SELECT count(*) FROM ingest_jobs
		 WHERE user_id = $1 AND status IN ('pending', 'processing')`, userID).Scan(&n)
	return n, err
}

// Reivindicar pega o próximo job da fila, marcando-o como `processing` no mesmo
// comando.
//
// Só os de `tipo = 'midia'`: job de página é do node (`ReivindicarPagina`), e o
// worker do cluster, que só sabe baixar arquivo, receberia HTML.
//
// `FOR UPDATE SKIP LOCKED` é o padrão de fila do rachão: dois workers nunca
// pegam o mesmo job, e nenhum deles fica esperando o outro. Também resgata o
// que ficou preso em `processing` além do prazo — worker que morreu no meio.
func (r *Jobs) Reivindicar(ctx context.Context) (*Job, error) {
	j, err := scanJob(r.pool.QueryRow(ctx, `
		UPDATE ingest_jobs
		SET status = 'processing', attempts = attempts + 1, updated_at = now()
		WHERE id = (
			SELECT id FROM ingest_jobs
			WHERE tipo = 'midia'
			  AND ((status = 'pending' AND attempts < $1)
			    OR (status = 'processing' AND updated_at < now() - $2::interval
			        AND attempts < $1))
			ORDER BY created_at
			FOR UPDATE SKIP LOCKED
			LIMIT 1
		)
		RETURNING `+colunasJob, MaxTentativas, PrazoTravado.String()))
	if errors.Is(err, ErrJobNaoEncontrado) {
		return nil, ErrFilaVazia
	}
	return j, err
}

// ReivindicarPagina é o `Reivindicar` do node: o próximo link de página, com a
// mesma fila (`SKIP LOCKED`), as mesmas tentativas e o mesmo resgate do que
// ficou preso.
func (r *Jobs) ReivindicarPagina(ctx context.Context) (*Job, error) {
	j, err := scanJob(r.pool.QueryRow(ctx, `
		UPDATE ingest_jobs
		SET status = 'processing', attempts = attempts + 1, updated_at = now()
		WHERE id = (
			SELECT id FROM ingest_jobs
			WHERE tipo = 'pagina'
			  AND ((status = 'pending' AND attempts < $1)
			    OR (status = 'processing' AND updated_at < now() - $2::interval
			        AND attempts < $1))
			ORDER BY created_at
			FOR UPDATE SKIP LOCKED
			LIMIT 1
		)
		RETURNING `+colunasJob, MaxTentativas, PrazoTravado.String()))
	if errors.Is(err, ErrJobNaoEncontrado) {
		return nil, ErrFilaVazia
	}
	return j, err
}

// PaginaEmCurso devolve o job de página que o node está atendendo. É o que as
// rotas do node usam para saber DE QUEM é o arquivo — e a consulta já recorta
// por tipo e por estado: um id de job de mídia, ou de um job que ninguém
// reivindicou, não é encontrado.
func (r *Jobs) PaginaEmCurso(ctx context.Context, id string) (*Job, error) {
	return scanJob(r.pool.QueryRow(ctx, `
		SELECT `+colunasJob+` FROM ingest_jobs
		 WHERE id = $1 AND tipo = 'pagina' AND status = 'processing'`, id))
}

// EntregarPagina é o node dizendo "baixei, o arquivo está na área de espera".
//
// O job VIRA um job de mídia, com a fonte trocada pelo arquivo enviado e as
// tentativas zeradas — as do download não devem gastar as da ingestão. O id é
// o mesmo, então quem pediu acompanha uma coisa só do começo ao fim.
//
// Título e artista só entram onde o pedido não trouxe: o que o node manda é o
// que o site diz do vídeo, e isso perde do que a pessoa escolheu.
func (r *Jobs) EntregarPagina(ctx context.Context, id, uploadID, title, artist, reserva string) (*Job, error) {
	return scanJob(r.pool.QueryRow(ctx, `
		UPDATE ingest_jobs
		SET source_url = $2, tipo = 'midia', status = 'pending', attempts = 0,
		    title = coalesce(nullif(title, ''), nullif($3, '')),
		    artist = coalesce(nullif(artist, ''), nullif($4, '')),
		    fallback_title = nullif($5, ''),
		    error = NULL, updated_at = now()
		WHERE id = $1 AND tipo = 'pagina' AND status = 'processing'
		RETURNING `+colunasJob, id, FonteUpload(uploadID), title, artist, reserva))
}

// Desistir encerra o job como `error` SEM gastar as tentativas que sobraram.
// É para a falha que repetir não conserta: conta sem espaço, vídeo que não
// existe, faixa longa demais.
func (r *Jobs) Desistir(ctx context.Context, jobID, motivo string) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE ingest_jobs SET status = 'error', error = $2, updated_at = now()
		WHERE id = $1`, jobID, motivo)
	return err
}

func (r *Jobs) Concluir(ctx context.Context, jobID, trackID string) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE ingest_jobs
		SET status = 'ready', track_id = $2, error = NULL, updated_at = now()
		WHERE id = $1`, jobID, trackID)
	return err
}

// Falhar devolve o job para a fila enquanto houver tentativa sobrando; na
// última, encerra como `error` — senão o worker ficaria repetindo para sempre
// uma URL que não existe mais.
func (r *Jobs) Falhar(ctx context.Context, jobID, motivo string) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE ingest_jobs
		SET status = CASE WHEN attempts >= $3 THEN 'error' ELSE 'pending' END,
		    error = $2, updated_at = now()
		WHERE id = $1`, jobID, motivo, MaxTentativas)
	return err
}
