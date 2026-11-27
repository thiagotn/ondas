package httpapi

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/thiagotn/ondas/api/internal/acervo"
	"github.com/thiagotn/ondas/api/internal/admin"
	"github.com/thiagotn/ondas/api/internal/storage"
)

// O lado do NODE na fila de links de página (migração 0013).
//
// A PWA enfileira um link do YouTube ou do SoundCloud; o worker do cluster não
// sabe resolvê-lo (ele baixa arquivo, não página — ADR 0013 do homelab,
// decisões 37 e 74). Quem resolve é o node do Hermes, e estas rotas são como
// ele conversa com a fila:
//
//	reivindicar → pega o próximo link
//	vaga        → pede onde gravar o arquivo baixado
//	pronto      → "gravei"; o job vira mídia e o worker faz o resto
//	falha       → "não deu", com um código de uma lista fechada
//
// Tudo aqui é só token de máquina. O que impede o token de escrever na conta
// errada não é um `if`: é `PaginaEmCurso`, que só acha job de PÁGINA em
// andamento, e a key do arquivo, que sai do dono DAQUELE job.

type paginaJSON struct {
	ID  string `json:"id"`
	URL string `json:"url"`
	// Teto do arquivo, para o node desistir antes de subir o que seria recusado.
	MaxBytes int64 `json:"maxBytes"`
}

// reivindicarPagina entrega o próximo link ao node. 204 quando a fila está
// vazia — é o caso comum, e não é erro.
func (s *Server) reivindicarPagina(w http.ResponseWriter, r *http.Request) {
	job, err := s.jobs.ReivindicarPagina(r.Context())
	if errors.Is(err, acervo.ErrFilaVazia) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		slog.Error("reivindicar página", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "erro ao consultar")
		return
	}
	slog.Info("página reivindicada pelo node", "job", job.ID, "tentativa", job.Attempts)
	escreverJSON(w, http.StatusOK, paginaJSON{ID: job.ID, URL: job.PaginaURL, MaxBytes: s.maxUploadBytesDe(r.Context(), job.UserID)})
}

// paginaEmCurso acha o job da rota. 404 para tudo que não seja um job de página
// em andamento — id malformado, job de mídia, job de outra fase.
func (s *Server) paginaEmCurso(w http.ResponseWriter, r *http.Request) (*acervo.Job, bool) {
	id := chi.URLParam(r, "id")
	if _, err := uuid.Parse(id); err != nil {
		escreverErro(w, http.StatusNotFound, "ingestão não encontrada")
		return nil, false
	}
	job, err := s.jobs.PaginaEmCurso(r.Context(), id)
	if errors.Is(err, acervo.ErrJobNaoEncontrado) {
		escreverErro(w, http.StatusNotFound, "ingestão não encontrada")
		return nil, false
	}
	if err != nil {
		slog.Error("job de página", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "erro ao consultar")
		return nil, false
	}
	return job, true
}

// semEspaco encerra o job quando a conta de quem pediu não tem cota. Falha
// DEFINITIVA: repetir o download não cria espaço.
func (s *Server) semEspaco(w http.ResponseWriter, r *http.Request, job *acervo.Job, bytes int64) bool {
	err := s.painel.ConferirCota(r.Context(), job.UserID, bytes)
	var cheio *admin.ErrSemEspaco
	if !errors.As(err, &cheio) {
		if err != nil {
			slog.Error("conferir cota da página", "erro", err)
		}
		return false
	}
	if err := s.jobs.Desistir(r.Context(), job.ID, admin.MensagemSemEspaco); err != nil {
		slog.Error("encerrar página sem espaço", "erro", err)
	}
	escreverErroCod(w, http.StatusRequestEntityTooLarge, CodCotaExcedida, admin.MensagemSemEspaco,
		map[string]any{"usado": cheio.UsadoBytes, "cota": cheio.CotaBytes})
	return true
}

// vagaDaPagina assina o PUT do arquivo que o node baixou. A key é da área de
// espera de quem PEDIU o job: é lá que o worker vai procurar, e é isso que faz
// a faixa nascer na conta certa sem o node dizer conta nenhuma.
func (s *Server) vagaDaPagina(w http.ResponseWriter, r *http.Request) {
	job, ok := s.paginaEmCurso(w, r)
	if !ok {
		return
	}
	var req struct {
		Bytes int64 `json:"bytes"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	if req.Bytes <= 0 {
		escreverErro(w, http.StatusBadRequest, "informe o tamanho do arquivo")
		return
	}
	// O teto é o de quem PEDIU o link (`job.UserID`), como em toda a fila: é na
	// área de espera dessa conta que o arquivo vai ser gravado.
	max := s.maxUploadBytesDe(r.Context(), job.UserID)
	if req.Bytes > max {
		escreverErroCod(w, http.StatusRequestEntityTooLarge, CodArquivoGrandeDemais,
			"arquivo grande demais: o limite é "+megabytes(max), map[string]any{"limite": max})
		return
	}
	if s.semEspaco(w, r, job, req.Bytes) {
		return
	}
	id := uuid.NewString()
	validade := validadeDoPUT(req.Bytes)
	url, err := s.r2.URLAssinadaPUT(r.Context(), storage.KeyUploadStage(job.UserID, id), validade)
	if err != nil {
		slog.Error("assinar PUT da página", "erro", err)
		escreverErro(w, http.StatusServiceUnavailable, "não foi possível preparar o envio")
		return
	}
	escreverJSON(w, http.StatusOK, vagaJSON{
		ID: id, URL: url, ExpiraEmS: int(validade.Seconds()), MaxBytes: max,
	})
}

// paginaPronta recebe o "gravei" do node e passa o job para o worker.
//
// As conferências são as do `finalizarUpload`, e pelo mesmo motivo: a URL
// assinada não limita bytes, então o tamanho que vale é o do objeto.
func (s *Server) paginaPronta(w http.ResponseWriter, r *http.Request) {
	job, ok := s.paginaEmCurso(w, r)
	if !ok {
		return
	}
	var req struct {
		UploadID string `json:"uploadId"`
		Title    string `json:"title"`
		Artist   string `json:"artist"`
		Nome     string `json:"nome"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	if _, err := uuid.Parse(req.UploadID); err != nil {
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return
	}
	key := storage.KeyUploadStage(job.UserID, req.UploadID)
	tamanho, err := s.r2.Tamanho(r.Context(), key)
	if errors.Is(err, storage.ErrObjetoAusente) {
		escreverErro(w, http.StatusNotFound, "o arquivo não chegou ao bucket — refaça o envio")
		return
	}
	if err != nil {
		slog.Error("conferir arquivo da página", "erro", err)
		escreverErro(w, http.StatusServiceUnavailable, "não foi possível confirmar o envio")
		return
	}
	if tamanho == 0 {
		s.descartarUpload(r, key)
		escreverErro(w, http.StatusBadRequest, "o arquivo chegou vazio")
		return
	}
	if max := s.maxUploadBytesDe(r.Context(), job.UserID); tamanho > max {
		s.descartarUpload(r, key)
		escreverErroCod(w, http.StatusRequestEntityTooLarge, CodArquivoGrandeDemais,
			"arquivo grande demais: o limite é "+megabytes(max), map[string]any{"limite": max})
		return
	}
	if s.semEspaco(w, r, job, tamanho) {
		s.descartarUpload(r, key)
		return
	}
	entregue, err := s.jobs.EntregarPagina(r.Context(), job.ID, req.UploadID,
		cortar(req.Title, maxNomeArquivo), cortar(req.Artist, maxNomeArquivo), cortar(req.Nome, maxNomeArquivo))
	if err != nil {
		slog.Error("entregar página", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível enfileirar")
		return
	}
	slog.Info("página baixada pelo node", "job", job.ID, "bytes", tamanho)
	escreverJSON(w, http.StatusAccepted, paraJobJSON(entregue))
}

// paginaFalhou recebe o "não deu" do node.
//
// O corpo traz um CÓDIGO, e a frase gravada sai de `mensagemDaPagina` — o node
// não escreve texto livre no job de ninguém. `pagina_falhou` é a falha que
// pode passar sozinha (rede, site fora do ar) e devolve o job à fila enquanto
// houver tentativa; as outras duas são definitivas.
func (s *Server) paginaFalhou(w http.ResponseWriter, r *http.Request) {
	job, ok := s.paginaEmCurso(w, r)
	if !ok {
		return
	}
	var req struct {
		Code string `json:"code"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	frase, conhecido := mensagemDaPagina[req.Code]
	if !conhecido {
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return
	}
	var err error
	if req.Code == CodPaginaFalhou {
		err = s.jobs.Falhar(r.Context(), job.ID, frase)
	} else {
		err = s.jobs.Desistir(r.Context(), job.ID, frase)
	}
	if err != nil {
		slog.Error("marcar falha da página", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "erro ao consultar")
		return
	}
	slog.Info("página falhou no node", "job", job.ID, "code", req.Code)
	escreverJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
