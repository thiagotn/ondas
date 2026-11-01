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
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

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
	created_at, updated_at`

func scanJob(row pgx.Row) (*Job, error) {
	var j Job
	err := row.Scan(&j.ID, &j.UserID, &j.SourceURL, &j.Title, &j.Artist,
		&j.TituloReserva, &j.Status, &j.Attempts, &j.Error, &j.TrackID,
		&j.DestinoID, &j.Visibilidade,
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
	return r.enfileirar(ctx, userID, url, title, artist, "", d)
}

// EnfileirarEnvio é o Enfileirar de um envio de arquivo: além do título escolhido,
// guarda um título de RESERVA — o nome do arquivo — que só é usado se o
// arquivo não tiver tag nenhuma. Método irmão em vez de um parâmetro a mais
// porque o caminho do bot não tem nome de arquivo para informar.
func (r *Jobs) EnfileirarEnvio(ctx context.Context, userID, fonte, title, artist, reserva string, d Destino) (job *Job, novo bool, err error) {
	return r.enfileirar(ctx, userID, fonte, title, artist, reserva, d)
}

func (r *Jobs) enfileirar(ctx context.Context, userID, url, title, artist, reserva string, d Destino) (job *Job, novo bool, err error) {
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
		                         destino_id, visibilidade)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (user_id, source_url, coalesce(destino_id, user_id), visibilidade)
		WHERE status IN ('pending', 'processing')
		DO NOTHING
		RETURNING `+colunasJob, userID, url, t, a, reserva, destino, vis))
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

func (r *Jobs) PorID(ctx context.Context, userID, id string) (*Job, error) {
	return scanJob(r.pool.QueryRow(ctx,
		`SELECT `+colunasJob+` FROM ingest_jobs WHERE id = $1 AND user_id = $2`, id, userID))
}

// Reivindicar pega o próximo job da fila, marcando-o como `processing` no mesmo
// comando.
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
			WHERE (status = 'pending' AND attempts < $1)
			   OR (status = 'processing' AND updated_at < now() - $2::interval
			       AND attempts < $1)
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
