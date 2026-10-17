package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/thiagotn/ondas/api/internal/acervo"
	"github.com/thiagotn/ondas/api/internal/storage"
)

// Envio de arquivo local pela PWA, em três passos:
//
//  1. `POST /acervo/upload` reserva uma vaga e devolve um PUT assinado;
//  2. o NAVEGADOR grava o arquivo direto no R2 com essa URL;
//  3. `POST /acervo/upload/{id}/finalizar` enfileira a ingestão.
//
// Do passo 3 em diante é o mesmo job da fase 2 — mesmo worker, mesma fila,
// mesmo `GET /acervo/ingest/{id}` para acompanhar. A tela de envio não precisa
// de um segundo mecanismo de acompanhamento.
//
// Por que os bytes não passam pela API: o túnel da Cloudflare tem teto de
// ~100MB por requisição (ADR 0007), e o link do homelab é residencial — subir
// por dentro gastaria o upload do dono duas vezes (navegador→homelab→R2) e
// seria mais lento que o caminho direto.
//
// Só sessão entra aqui, nunca o `X-Ondas-Token`: o token do bot existe para
// ingerir URL, e não deve poder escrever objeto no bucket.
const (
	// Prazo do PUT assinado. Tem de cobrir o envio inteiro: 15 minutos para
	// 60MB ainda funciona num upload de ~70kB/s.
	validadeUploadPUT = 15 * time.Minute
	// Teto do nome do arquivo que a tela manda como título sugerido.
	maxNomeArquivo = 200
)

type vagaJSON struct {
	ID string `json:"id"`
	// PUT assinado. Vai direto para o R2 e vence rápido — não é para guardar.
	URL       string `json:"url"`
	ExpiraEmS int    `json:"expiraEmS"`
	MaxBytes  int64  `json:"maxBytes"`
}

func (s *Server) pedirVagaDeUpload(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Bytes int64 `json:"bytes"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	max := s.maxUploadBytes()
	if req.Bytes <= 0 {
		escreverErro(w, http.StatusBadRequest, "informe o tamanho do arquivo")
		return
	}
	// Recusa ANTES do envio: o teto de verdade é conferido no finalizar, com
	// o tamanho real do objeto, mas deixar o usuário subir 500MB para só
	// então ouvir "não" seria cruel com o upload dele.
	if req.Bytes > max {
		escreverErro(w, http.StatusRequestEntityTooLarge, "arquivo grande demais: o limite é "+megabytes(max))
		return
	}

	user := usuarioDe(r.Context())
	id := uuid.NewString()
	url, err := s.r2.URLAssinadaPUT(r.Context(), storage.KeyUploadStage(user.ID, id), validadeUploadPUT)
	if err != nil {
		slog.Error("assinar PUT de upload", "erro", err)
		escreverErro(w, http.StatusServiceUnavailable, "não foi possível preparar o envio")
		return
	}
	escreverJSON(w, http.StatusOK, vagaJSON{
		ID:        id,
		URL:       url,
		ExpiraEmS: int(validadeUploadPUT.Seconds()),
		MaxBytes:  max,
	})
}

func (s *Server) finalizarUpload(w http.ResponseWriter, r *http.Request) {
	user := usuarioDe(r.Context())
	id, ok := idDaRota(w, r)
	if !ok {
		return
	}
	var req struct {
		Title  string `json:"title"`
		Artist string `json:"artist"`
		// Nome do arquivo, já limpo pelo cliente. Vai para o título de
		// RESERVA, não para `title`: as tags do arquivo têm de ganhar dele.
		Nome string `json:"nome"`
	}
	if !lerJSON(w, r, &req) {
		return
	}

	// A key é derivada do dono da SESSÃO, não de nada que o cliente mandou:
	// não existe pedido capaz de finalizar o envio de outra pessoa.
	key := storage.KeyUploadStage(user.ID, id)
	tamanho, err := s.r2.Tamanho(r.Context(), key)
	if errors.Is(err, storage.ErrObjetoAusente) {
		escreverErro(w, http.StatusNotFound, "o arquivo não chegou ao bucket — refaça o envio")
		return
	}
	if err != nil {
		slog.Error("conferir upload", "erro", err)
		escreverErro(w, http.StatusServiceUnavailable, "não foi possível confirmar o envio")
		return
	}
	if tamanho == 0 {
		s.descartarUpload(r, key)
		escreverErro(w, http.StatusBadRequest, "o arquivo chegou vazio")
		return
	}
	// Aqui é o teto que vale: a URL assinada não limita bytes, então quem
	// mentiu no passo 1 é pego agora — e o objeto sai na hora, em vez de
	// ficar esperando a varredura de abandonados.
	if max := s.maxUploadBytes(); tamanho > max {
		s.descartarUpload(r, key)
		escreverErro(w, http.StatusRequestEntityTooLarge, "arquivo grande demais: o limite é "+megabytes(max))
		return
	}

	titulo := cortar(req.Title, maxNomeArquivo)
	artista := cortar(req.Artist, maxNomeArquivo)

	job, novo, err := s.jobs.EnfileirarEnvio(r.Context(), user.ID, acervo.FonteUpload(id),
		titulo, artista, cortar(req.Nome, maxNomeArquivo))
	if err != nil {
		slog.Error("enfileirar upload", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível enfileirar")
		return
	}
	status := http.StatusAccepted
	if !novo {
		// Finalizar duas vezes (toque duplo, reenvio da aba) não cria um
		// segundo job: o de antes continua valendo.
		status = http.StatusOK
	}
	escreverJSON(w, status, paraJobJSON(job))
}

// descartarUpload apaga um objeto recusado. Best-effort de propósito: se o R2
// não colaborar, a varredura de abandonados pega depois — o que não pode é a
// resposta de erro ficar presa esperando a limpeza.
func (s *Server) descartarUpload(r *http.Request, key string) {
	if err := s.r2.Remover(r.Context(), key); err != nil {
		slog.Warn("upload recusado continuou no bucket", "key", key, "erro", err)
	}
}

// cortar limita o texto em RUNAS, não em bytes: cortar no meio de um
// caractere multibyte deixaria um acento quebrado no título.
func cortar(texto string, max int) string {
	t := strings.TrimSpace(texto)
	if runas := []rune(t); len(runas) > max {
		return strings.TrimSpace(string(runas[:max]))
	}
	return t
}

func (s *Server) maxUploadBytes() int64 {
	return int64(s.cfg.IngestMaxMB) << 20
}

func megabytes(bytes int64) string {
	mb := bytes >> 20
	if mb <= 0 {
		return "menos de 1 MB"
	}
	return strconv.FormatInt(mb, 10) + " MB"
}
