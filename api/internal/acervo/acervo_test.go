package acervo_test

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/thiagotn/ondas/api/internal/acervo"
	"github.com/thiagotn/ondas/api/internal/dbtest"
	"github.com/thiagotn/ondas/api/internal/ingest"
)

func nova(userID, titulo string) acervo.Nova {
	return acervo.Nova{
		ID:        uuidDeTeste(titulo),
		UserID:    userID,
		Title:     titulo,
		Artist:    "Alguém",
		Genre:     "acervo",
		DurS:      201,
		AudioKey:  "u/" + userID + "/a/" + titulo + ".mp3",
		AudioType: "audio/mpeg",
		SizeBytes: 1234,
	}
}

// uuidDeTeste gera um uuid estável a partir do nome, para a falha apontar qual
// faixa era.
func uuidDeTeste(semente string) string {
	h := []byte("00000000-0000-4000-8000-000000000000")
	for i, c := range []byte(semente) {
		pos := len(h) - 1 - (i % 12)
		h[pos] = "0123456789abcdef"[int(c)%16]
	}
	return string(h)
}

func TestFaixaDeUmNaoApareceParaOutro(t *testing.T) {
	pool := dbtest.Pool(t)
	ctx := context.Background()
	tracks := acervo.NewTracks(pool)

	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	outro := dbtest.CriarUsuario(t, pool, "outro@exemplo.test")

	minha, err := tracks.Criar(ctx, nova(eu, "minha"))
	require.NoError(t, err)
	_, err = tracks.Criar(ctx, nova(outro, "dele"))
	require.NoError(t, err)

	minhas, err := tracks.Listar(ctx, eu)
	require.NoError(t, err)
	require.Len(t, minhas, 1)
	require.Equal(t, "minha", minhas[0].Title)

	// O recorte por dono está na consulta, não num `if` depois: pedir a faixa
	// de outro tem de dar "não encontrada", não os metadados dela.
	_, err = tracks.PorID(ctx, outro, minha.ID)
	require.ErrorIs(t, err, acervo.ErrNaoEncontrada)

	// E remover a de outro não pode funcionar.
	_, err = tracks.Remover(ctx, outro, minha.ID)
	require.Error(t, err)
	aindaLa, err := tracks.PorID(ctx, eu, minha.ID)
	require.NoError(t, err)
	require.Equal(t, minha.ID, aindaLa.ID)
}

func TestCapaAusenteViraVazioENaoNulo(t *testing.T) {
	pool := dbtest.Pool(t)
	ctx := context.Background()
	tracks := acervo.NewTracks(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	semCapa, err := tracks.Criar(ctx, nova(eu, "sem-capa"))
	require.NoError(t, err)
	require.Empty(t, semCapa.ArtKey)
	require.Empty(t, semCapa.ArtThumbKey)

	n := nova(eu, "com-capa")
	n.ArtKey = "u/x/art/a-480.jpg"
	n.ArtThumbKey = "u/x/art/a-150.jpg"
	comCapa, err := tracks.Criar(ctx, n)
	require.NoError(t, err)
	require.Equal(t, n.ArtKey, comCapa.ArtKey)
	require.Equal(t, n.ArtThumbKey, comCapa.ArtThumbKey)
}

func TestFormaDeOndaVaiEVoltaInteira(t *testing.T) {
	pool := dbtest.Pool(t)
	ctx := context.Background()
	tracks := acervo.NewTracks(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	// Faixa ingerida antes desta coluna existir: a leitura precisa dar string
	// vazia, não estourar no NULL, senão o acervo inteiro para de listar.
	semPicos, err := tracks.Criar(ctx, nova(eu, "sem-picos"))
	require.NoError(t, err)
	require.Empty(t, semPicos.Peaks)

	n := nova(eu, "com-picos")
	n.Peaks = strings.Repeat("Z", ingest.PicosPorFaixa)
	comPicos, err := tracks.Criar(ctx, n)
	require.NoError(t, err)
	require.Equal(t, n.Peaks, comPicos.Peaks)

	// E sobrevive à listagem, que é por onde a PWA recebe.
	lista, err := tracks.Listar(ctx, eu)
	require.NoError(t, err)
	porID := map[string]acervo.Visivel{}
	for _, t := range lista {
		porID[t.ID] = t
	}
	require.Equal(t, n.Peaks, porID[comPicos.ID].Peaks)
	require.Empty(t, porID[semPicos.ID].Peaks)
}

func TestListagemVemDaMaisNovaParaAMaisVelha(t *testing.T) {
	pool := dbtest.Pool(t)
	ctx := context.Background()
	tracks := acervo.NewTracks(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	for _, nome := range []string{"primeira", "segunda", "terceira"} {
		_, err := tracks.Criar(ctx, nova(eu, nome))
		require.NoError(t, err)
	}
	lista, err := tracks.Listar(ctx, eu)
	require.NoError(t, err)
	require.Len(t, lista, 3)
	for i := 1; i < len(lista); i++ {
		require.False(t, lista[i].CreatedAt.After(lista[i-1].CreatedAt),
			"a lista deveria vir da mais nova para a mais velha")
	}
}

func TestListagemDeQuemNaoTemNadaVemVazia(t *testing.T) {
	pool := dbtest.Pool(t)
	tracks := acervo.NewTracks(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	lista, err := tracks.Listar(context.Background(), eu)
	require.NoError(t, err)
	// Vazia, não nula: `null` no JSON faria a PWA quebrar ao iterar.
	require.NotNil(t, lista)
	require.Empty(t, lista)
}

// O bot reenvia: quando o usuário toca no botão de novo, ou quando o Telegram
// repete a entrega. Dois pedidos para a mesma URL são UMA ingestão.
func TestMesmaURLDuasVezesNaoEnfileiraDuasIngestoes(t *testing.T) {
	pool := dbtest.Pool(t)
	ctx := context.Background()
	jobs := acervo.NewJobs(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	primeiro, novo, err := jobs.Enfileirar(ctx, eu, "https://exemplo.test/a.mp3", "Título", "", acervo.Destino{})
	require.NoError(t, err)
	require.True(t, novo)

	segundo, novo, err := jobs.Enfileirar(ctx, eu, "https://exemplo.test/a.mp3", "Outro", "", acervo.Destino{})
	require.NoError(t, err)
	require.False(t, novo, "o segundo pedido não é uma ingestão nova")
	require.Equal(t, primeiro.ID, segundo.ID)
	// E não sobrescreve o que já estava a caminho.
	require.Equal(t, "Título", segundo.Title)
}

// A unicidade é de jobs ATIVOS: depois que o primeiro terminou, a mesma URL
// pode ser ingerida de novo (outra versão do arquivo, por exemplo).
func TestURLPodeSerIngeridaDeNovoDepoisDeTerminar(t *testing.T) {
	pool := dbtest.Pool(t)
	ctx := context.Background()
	jobs := acervo.NewJobs(pool)
	tracks := acervo.NewTracks(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	primeiro, _, err := jobs.Enfileirar(ctx, eu, "https://exemplo.test/a.mp3", "", "", acervo.Destino{})
	require.NoError(t, err)
	_, err = jobs.Reivindicar(ctx)
	require.NoError(t, err)
	faixa, err := tracks.Criar(ctx, nova(eu, "pronta"))
	require.NoError(t, err)
	require.NoError(t, jobs.Concluir(ctx, primeiro.ID, faixa.ID))

	segundo, novo, err := jobs.Enfileirar(ctx, eu, "https://exemplo.test/a.mp3", "", "", acervo.Destino{})
	require.NoError(t, err)
	require.True(t, novo)
	require.NotEqual(t, primeiro.ID, segundo.ID)
}

func TestMesmaURLDeDonosDiferentesSaoIngestoesSeparadas(t *testing.T) {
	pool := dbtest.Pool(t)
	ctx := context.Background()
	jobs := acervo.NewJobs(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	outro := dbtest.CriarUsuario(t, pool, "outro@exemplo.test")

	a, _, err := jobs.Enfileirar(ctx, eu, "https://exemplo.test/a.mp3", "", "", acervo.Destino{})
	require.NoError(t, err)
	b, novo, err := jobs.Enfileirar(ctx, outro, "https://exemplo.test/a.mp3", "", "", acervo.Destino{})
	require.NoError(t, err)
	require.True(t, novo)
	require.NotEqual(t, a.ID, b.ID)
}

// Dois workers no ar durante um rollout não podem pegar o mesmo job — é o que
// o FOR UPDATE SKIP LOCKED garante.
func TestDoisReivindicadoresNaoPegamOMesmoJob(t *testing.T) {
	pool := dbtest.Pool(t)
	ctx := context.Background()
	jobs := acervo.NewJobs(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	const n = 5
	for i := 0; i < n; i++ {
		_, _, err := jobs.Enfileirar(ctx, eu, "https://exemplo.test/"+uuidDeTeste(string(rune('a'+i)))+".mp3", "", "", acervo.Destino{})
		require.NoError(t, err)
	}

	largada := make(chan struct{})
	var mu sync.Mutex
	vistos := map[string]int{}
	var wg sync.WaitGroup
	for i := 0; i < 2*n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-largada
			job, err := jobs.Reivindicar(ctx)
			if err != nil {
				return // fila vazia é resultado legítimo
			}
			mu.Lock()
			vistos[job.ID]++
			mu.Unlock()
		}()
	}
	close(largada)
	wg.Wait()

	require.Len(t, vistos, n, "todos os jobs deveriam ter sido pegos")
	for id, vezes := range vistos {
		require.Equal(t, 1, vezes, "job %s foi pego mais de uma vez", id)
	}
}

func TestJobDesisteDepoisDasTentativas(t *testing.T) {
	pool := dbtest.Pool(t)
	ctx := context.Background()
	jobs := acervo.NewJobs(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	criado, _, err := jobs.Enfileirar(ctx, eu, "https://exemplo.test/morta.mp3", "", "", acervo.Destino{})
	require.NoError(t, err)

	// Falhar devolve para a fila enquanto houver tentativa sobrando.
	for i := 1; i < acervo.MaxTentativas; i++ {
		job, err := jobs.Reivindicar(ctx)
		require.NoError(t, err)
		require.Equal(t, criado.ID, job.ID)
		require.NoError(t, jobs.Falhar(ctx, job.ID, "origem fora do ar"))

		depois, err := jobs.PorID(ctx, eu, criado.ID)
		require.NoError(t, err)
		require.Equal(t, "pending", depois.Status, "ainda deveria tentar de novo")
	}

	// Na última, encerra como erro — senão o worker repetiria para sempre.
	job, err := jobs.Reivindicar(ctx)
	require.NoError(t, err)
	require.NoError(t, jobs.Falhar(ctx, job.ID, "origem fora do ar"))

	final, err := jobs.PorID(ctx, eu, criado.ID)
	require.NoError(t, err)
	require.Equal(t, "error", final.Status)
	require.Equal(t, "origem fora do ar", final.Error)

	// E não volta mais para a fila.
	_, err = jobs.Reivindicar(ctx)
	require.ErrorIs(t, err, acervo.ErrFilaVazia)
}

func TestJobTravadoVoltaParaAFila(t *testing.T) {
	pool := dbtest.Pool(t)
	ctx := context.Background()
	jobs := acervo.NewJobs(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	criado, _, err := jobs.Enfileirar(ctx, eu, "https://exemplo.test/a.mp3", "", "", acervo.Destino{})
	require.NoError(t, err)
	_, err = jobs.Reivindicar(ctx)
	require.NoError(t, err)

	// Enquanto está sendo processado, ninguém mais pega.
	_, err = jobs.Reivindicar(ctx)
	require.ErrorIs(t, err, acervo.ErrFilaVazia)

	// Worker morto no meio: o updated_at envelhece e o job volta.
	_, err = pool.Exec(ctx,
		`UPDATE ingest_jobs SET updated_at = now() - interval '30 minutes' WHERE id = $1`,
		criado.ID)
	require.NoError(t, err)

	resgatado, err := jobs.Reivindicar(ctx)
	require.NoError(t, err)
	require.Equal(t, criado.ID, resgatado.ID)
	require.Equal(t, 2, resgatado.Attempts)
}

func TestStatusDeOutroDonoNaoEhVisivel(t *testing.T) {
	pool := dbtest.Pool(t)
	ctx := context.Background()
	jobs := acervo.NewJobs(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")
	outro := dbtest.CriarUsuario(t, pool, "outro@exemplo.test")

	meu, _, err := jobs.Enfileirar(ctx, eu, "https://exemplo.test/a.mp3", "", "", acervo.Destino{})
	require.NoError(t, err)

	_, err = jobs.PorID(ctx, outro, meu.ID)
	require.ErrorIs(t, err, acervo.ErrJobNaoEncontrado)
}

func TestConcluirApontaParaAFaixa(t *testing.T) {
	pool := dbtest.Pool(t)
	ctx := context.Background()
	jobs := acervo.NewJobs(pool)
	tracks := acervo.NewTracks(pool)
	eu := dbtest.CriarUsuario(t, pool, "eu@exemplo.test")

	job, _, err := jobs.Enfileirar(ctx, eu, "https://exemplo.test/a.mp3", "", "", acervo.Destino{})
	require.NoError(t, err)
	faixa, err := tracks.Criar(ctx, nova(eu, "pronta"))
	require.NoError(t, err)
	require.NoError(t, jobs.Concluir(ctx, job.ID, faixa.ID))

	depois, err := jobs.PorID(ctx, eu, job.ID)
	require.NoError(t, err)
	require.Equal(t, "ready", depois.Status)
	require.Equal(t, faixa.ID, depois.TrackID)
	require.Empty(t, depois.Error)
}
