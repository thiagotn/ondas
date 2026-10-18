package httpapi

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/thiagotn/ondas/api/internal/acervo"
	"github.com/thiagotn/ondas/api/internal/auth"
)

// trackJSON sai no formato do `Track` do core, de propósito: assim a fase 3
// concatena as duas fontes sem tradutor no meio.
//
// As URLs são SEMPRE as nossas, nunca a assinada do R2 — o catálogo fica 24h no
// navegador e a assinatura vence antes. Quem assina na hora é o 302.
type trackJSON struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Artist   string `json:"artist"`
	Genre    string `json:"genre"`
	Dur      int    `json:"dur"`
	Art      string `json:"art"`
	ArtThumb string `json:"artThumb,omitempty"`
	Stream   string `json:"stream"`
	// Forma de onda medida na ingestão. Omitida quando não há: a PWA então
	// desenha barra lisa, que é o certo — ela não conhece esse áudio.
	Peaks string `json:"peaks,omitempty"`
	// Explícito, e não por omissão: `undefined` faria a PWA cair no heurístico
	// `index % 3 === 2` do protótipo e marcar música sua como [pro].
	Premium bool `json:"premium"`
}

// O prefixo evita colisão com os ids do Audius nas chaves de curtida, de
// download offline e do cache (`/offline/<id>`).
const prefixoID = "acervo:"

func paraJSON(t acervo.Track) trackJSON {
	j := trackJSON{
		ID:      prefixoID + t.ID,
		Title:   t.Title,
		Artist:  t.Artist,
		Genre:   t.Genre,
		Dur:     t.DurS,
		Stream:  "/api/acervo/" + t.ID + "/audio",
		Peaks:   t.Peaks,
		Premium: false,
	}
	if t.ArtKey != "" {
		j.Art = "/api/acervo/" + t.ID + "/art"
	}
	if t.ArtThumbKey != "" {
		j.ArtThumb = "/api/acervo/" + t.ID + "/art?p=thumb"
	}
	return j
}

type jobJSON struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	URL    string `json:"url"`
	Error  string `json:"error,omitempty"`
	// Preenchido quando o status é `ready`.
	TrackID string `json:"trackId,omitempty"`
}

func paraJobJSON(j *acervo.Job) jobJSON {
	saida := jobJSON{ID: j.ID, Status: j.Status, URL: j.SourceURL, Error: j.Error}
	if j.TrackID != "" {
		saida.TrackID = prefixoID + j.TrackID
	}
	return saida
}

// idDaRota valida o id antes de ir ao banco: um id que não é uuid faria o pgx
// devolver erro de sintaxe, e o handler responderia 500 onde 404 é o certo.
// O prefixo `acervo:` é tolerado porque é como a PWA enxerga o id.
func idDaRota(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := strings.TrimPrefix(chi.URLParam(r, "id"), prefixoID)
	if _, err := uuid.Parse(id); err != nil {
		escreverErro(w, http.StatusNotFound, "faixa não encontrada")
		return "", false
	}
	return id, true
}

// exigirAcervo recusa quando não há credencial de R2 — o login continua de pé
// sem ela, só o acervo não.
func (s *Server) exigirAcervo(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.r2 == nil {
			escreverErro(w, http.StatusServiceUnavailable, "acervo não configurado")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// exigirSessaoOuToken aceita os dois chamadores da ingestão: a PWA (cookie) e o
// bot do Telegram (`X-Ondas-Token`), que não tem sessão para usar.
func (s *Server) exigirSessaoOuToken(next http.Handler) http.Handler {
	comSessao := s.exigirSessao(next)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("X-Ondas-Token")
		if token == "" {
			comSessao.ServeHTTP(w, r)
			return
		}
		user, err := s.usuarioDoToken(r.Context(), token)
		if err != nil {
			slog.Warn("token de ingestão recusado", "ip", clienteIP(r), "erro", err)
			escreverErro(w, http.StatusUnauthorized, "token inválido")
			return
		}
		next.ServeHTTP(w, r.WithContext(comUsuario(r.Context(), user)))
	})
}

func (s *Server) usuarioDoToken(ctx context.Context, token string) (*auth.User, error) {
	if !s.cfg.IngestPorTokenConfigurado() {
		return nil, errors.New("token de ingestão não configurado")
	}
	soma := sha256.Sum256([]byte(token))
	esperado, err := hex.DecodeString(strings.TrimSpace(s.cfg.IngestTokenSHA256))
	if err != nil || len(esperado) != len(soma) {
		return nil, errors.New("INGEST_TOKEN_SHA256 malformado")
	}
	// Comparação em tempo constante: com `==` o tempo de resposta entrega o
	// prefixo correto byte a byte.
	if subtle.ConstantTimeCompare(soma[:], esperado) != 1 {
		return nil, errors.New("token não confere")
	}
	return s.users.PorEmail(ctx, s.cfg.IngestUserEmail)
}

func (s *Server) listarAcervo(w http.ResponseWriter, r *http.Request) {
	user := usuarioDe(r.Context())
	faixas, err := s.tracks.Listar(r.Context(), user.ID)
	if err != nil {
		slog.Error("listar acervo", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível ler o acervo")
		return
	}
	saida := make([]trackJSON, 0, len(faixas))
	for _, t := range faixas {
		saida = append(saida, paraJSON(t))
	}
	escreverJSON(w, http.StatusOK, map[string]any{"tracks": saida})
}

// audio redireciona para a URL assinada em vez de servir os bytes.
//
// Os bytes não passam pelo homelab: o link é residencial e o túnel tem teto de
// ~100MB por requisição (ADR 0007). O que passa é um 302 de ~1KB. E como a
// assinatura é feita a cada pedido, ela nunca vence dentro do cache do
// catálogo.
func (s *Server) audio(w http.ResponseWriter, r *http.Request) {
	s.redirecionarAssinado(w, r, func(t *acervo.Track) string { return t.AudioKey })
}

func (s *Server) arte(w http.ResponseWriter, r *http.Request) {
	s.redirecionarAssinado(w, r, func(t *acervo.Track) string {
		if r.URL.Query().Get("p") == "thumb" && t.ArtThumbKey != "" {
			return t.ArtThumbKey
		}
		return t.ArtKey
	})
}

func (s *Server) redirecionarAssinado(w http.ResponseWriter, r *http.Request, key func(*acervo.Track) string) {
	user := usuarioDe(r.Context())
	id, ok := idDaRota(w, r)
	if !ok {
		return
	}
	t, err := s.tracks.PorID(r.Context(), user.ID, id)
	if errors.Is(err, acervo.ErrNaoEncontrada) {
		escreverErro(w, http.StatusNotFound, "faixa não encontrada")
		return
	}
	if err != nil {
		slog.Error("buscar faixa", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "erro ao buscar a faixa")
		return
	}
	k := key(t)
	if k == "" {
		escreverErro(w, http.StatusNotFound, "faixa sem este arquivo")
		return
	}
	url, err := s.r2.URLAssinada(r.Context(), k)
	if err != nil {
		slog.Error("assinar url", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "erro ao liberar o arquivo")
		return
	}
	// O redirect não pode ser guardado por ninguém: ele carrega uma assinatura
	// com prazo, e um proxy que o cacheasse entregaria a URL a outra sessão.
	w.Header().Set("Cache-Control", "private, no-store")
	http.Redirect(w, r, url, http.StatusFound)
}

func (s *Server) removerFaixa(w http.ResponseWriter, r *http.Request) {
	user := usuarioDe(r.Context())
	id, ok := idDaRota(w, r)
	if !ok {
		return
	}
	t, err := s.tracks.Remover(r.Context(), user.ID, id)
	if errors.Is(err, acervo.ErrNaoEncontrada) || errors.Is(errors.Unwrap(err), acervo.ErrNaoEncontrada) {
		escreverErro(w, http.StatusNotFound, "faixa não encontrada")
		return
	}
	if err != nil {
		slog.Error("remover faixa", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível remover")
		return
	}
	// A linha já foi apagada; se a limpeza do R2 falhar, o objeto fica órfão
	// mas o acervo do usuário já está correto. Erro vai para o log, não para a
	// resposta.
	for _, k := range []string{t.AudioKey, t.ArtKey, t.ArtThumbKey} {
		if k == "" {
			continue
		}
		if err := s.r2.Remover(r.Context(), k); err != nil {
			slog.Error("objeto órfão no R2", "key", k, "erro", err)
		}
	}
	escreverJSON(w, http.StatusOK, map[string]string{"status": "removida"})
}

func (s *Server) ingerir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL    string `json:"url"`
		Title  string `json:"title"`
		Artist string `json:"artist"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	req.URL = strings.TrimSpace(req.URL)
	if req.URL == "" {
		escreverErro(w, http.StatusBadRequest, "informe a url da mídia")
		return
	}
	if len(req.URL) > 2048 {
		escreverErro(w, http.StatusBadRequest, "url longa demais")
		return
	}
	// A validação de verdade (esquema, destino público) é do worker, que é
	// quem vai conectar. Aqui só barramos o que é obviamente inútil enfileirar.
	if !strings.HasPrefix(req.URL, "http://") && !strings.HasPrefix(req.URL, "https://") {
		escreverErro(w, http.StatusBadRequest, "a url precisa ser http(s)")
		return
	}

	user := usuarioDe(r.Context())
	job, novo, err := s.jobs.Enfileirar(r.Context(), user.ID, req.URL,
		strings.TrimSpace(req.Title), strings.TrimSpace(req.Artist))
	if err != nil {
		slog.Error("enfileirar ingestão", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível enfileirar")
		return
	}
	status := http.StatusAccepted
	if !novo {
		// 200 em vez de 202: nada novo foi aceito, o pedido anterior continua.
		status = http.StatusOK
	}
	escreverJSON(w, status, paraJobJSON(job))
}

func (s *Server) statusIngestao(w http.ResponseWriter, r *http.Request) {
	user := usuarioDe(r.Context())
	id, ok := idDaRota(w, r)
	if !ok {
		return
	}
	job, err := s.jobs.PorID(r.Context(), user.ID, id)
	if errors.Is(err, acervo.ErrJobNaoEncontrado) {
		escreverErro(w, http.StatusNotFound, "ingestão não encontrada")
		return
	}
	if err != nil {
		slog.Error("status da ingestão", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "erro ao consultar")
		return
	}
	escreverJSON(w, http.StatusOK, paraJobJSON(job))
}
