package httpapi

import (
	"log/slog"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/thiagotn/ondas/api/internal/history"
)

// Teto do corpo do POST do histórico: 50 itens com título e artista no limite
// passam dos 4 KiB do `lerJSON` padrão.
const limiteCorpoHistorico = 32 << 10

// Quantas faixas sobem de uma vez. É o teto da fila offline do cliente
// (`packages/core/src/historico/fila.ts`): quem ficou sem rede por mais do que
// cinquenta faixas perde as mais antigas da fila, não o pedido inteiro.
const maxItensPorPedido = 50

// Título e artista são um retrato para a tela, não um depósito de texto.
const maxRunasDoRetrato = 200

// Nenhuma faixa tem um dia de duração. O teto existe para a coluna não guardar
// um número que só um cliente quebrado mandaria.
const maxSegundos = 24 * 60 * 60

type marcadorJSON struct {
	TrackID string  `json:"trackId"`
	Pos     float64 `json:"pos"`
	Dur     float64 `json:"dur"`
	// Epoch em milissegundos — o `Date.now()` de quem ouviu.
	Em int64 `json:"em"`
}

type itemJSON struct {
	TrackID string `json:"trackId"`
	Titulo  string `json:"titulo"`
	Artista string `json:"artista"`
	Dur     int    `json:"dur"`
	Em      int64  `json:"em"`
}

func marcadorParaJSON(m *history.Marcador) *marcadorJSON {
	if m == nil {
		return nil
	}
	return &marcadorJSON{TrackID: m.TrackID, Pos: m.Pos, Dur: m.Dur, Em: m.Em.UnixMilli()}
}

func itensParaJSON(itens []history.Item) []itemJSON {
	// `make` e não `nil`: lista vazia é `[]` no JSON.
	saida := make([]itemJSON, 0, len(itens))
	for _, it := range itens {
		saida = append(saida, itemJSON{
			TrackID: it.TrackID, Titulo: it.Titulo, Artista: it.Artista,
			Dur: it.Dur, Em: it.Em.UnixMilli(),
		})
	}
	return saida
}

func (s *Server) lerMarcador(w http.ResponseWriter, r *http.Request) {
	m, err := s.history.Marcador(r.Context(), usuarioDe(r.Context()).ID)
	if err != nil {
		slog.Error("ler marcador", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível ler o marcador")
		return
	}
	// `marcador: null` para quem nunca ouviu nada, e não um 404: é uma
	// resposta normal, e 404 aqui seria indistinguível de "a rota não existe",
	// que é o que a PWA nova vê quando fala com uma API antiga.
	escreverJSON(w, http.StatusOK, map[string]any{"marcador": marcadorParaJSON(m)})
}

// gravarMarcador responde com o marcador que FICOU, que pode não ser o que foi
// mandado: escrita mais velha que a vigente é ignorada (ver
// `history.GravarMarcador`) e a resposta é 200 do mesmo jeito. O cliente
// compara e, se perdeu, adota o que veio.
func (s *Server) gravarMarcador(w http.ResponseWriter, r *http.Request) {
	var req marcadorJSON
	if !lerJSON(w, r, &req) {
		return
	}
	if req.TrackID == "" || len(req.TrackID) > maxTamanhoID ||
		!segundosValidos(req.Pos) || !segundosValidos(req.Dur) || req.Em <= 0 {
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return
	}

	m, err := s.history.GravarMarcador(r.Context(), usuarioDe(r.Context()).ID, history.Marcador{
		TrackID: req.TrackID, Pos: req.Pos, Dur: req.Dur, Em: time.UnixMilli(req.Em),
	})
	if err != nil {
		slog.Error("gravar marcador", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível salvar o marcador")
		return
	}
	escreverJSON(w, http.StatusOK, map[string]any{"marcador": marcadorParaJSON(m)})
}

func (s *Server) listarHistorico(w http.ResponseWriter, r *http.Request) {
	itens, err := s.history.Listar(r.Context(), usuarioDe(r.Context()).ID)
	if err != nil {
		slog.Error("listar histórico", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível ler o histórico")
		return
	}
	escreverJSON(w, http.StatusOK, map[string]any{"itens": itensParaJSON(itens)})
}

// registrarHistorico recebe um lote e responde a coleção inteira que ficou.
//
// Em lote pelo mesmo motivo do `PATCH /likes`: um handler cobre a faixa que
// acabou de contar como ouvida e a fila que acumulou sem rede.
func (s *Server) registrarHistorico(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Itens []itemJSON `json:"itens"`
	}
	if !lerJSONAte(w, r, &req, limiteCorpoHistorico) {
		return
	}
	if len(req.Itens) > maxItensPorPedido {
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return
	}

	// Dedupe por faixa, ficando a escuta mais recente. Não é enfeite: a mesma
	// faixa duas vezes no lote são dois upserts na mesma linha, e o título que
	// ficaria gravado dependeria da ordem em que vieram.
	porFaixa := make(map[string]int, len(req.Itens))
	itens := make([]history.Item, 0, len(req.Itens))
	for _, it := range req.Itens {
		if it.TrackID == "" || len(it.TrackID) > maxTamanhoID ||
			utf8.RuneCountInString(it.Titulo) > maxRunasDoRetrato ||
			utf8.RuneCountInString(it.Artista) > maxRunasDoRetrato ||
			it.Dur < 0 || it.Dur > maxSegundos || it.Em <= 0 {
			escreverErro(w, http.StatusBadRequest, "requisição inválida")
			return
		}
		novo := history.Item{
			TrackID: it.TrackID, Titulo: it.Titulo, Artista: it.Artista,
			Dur: it.Dur, Em: time.UnixMilli(it.Em),
		}
		if i, repetido := porFaixa[it.TrackID]; repetido {
			if novo.Em.After(itens[i].Em) {
				itens[i] = novo
			}
			continue
		}
		porFaixa[it.TrackID] = len(itens)
		itens = append(itens, novo)
	}

	ficou, err := s.history.Registrar(r.Context(), usuarioDe(r.Context()).ID, itens)
	if err != nil {
		slog.Error("registrar histórico", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível salvar o histórico")
		return
	}
	escreverJSON(w, http.StatusOK, map[string]any{"itens": itensParaJSON(ficou)})
}

func (s *Server) limparHistorico(w http.ResponseWriter, r *http.Request) {
	if err := s.history.Limpar(r.Context(), usuarioDe(r.Context()).ID); err != nil {
		slog.Error("limpar histórico", "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível salvar o histórico")
		return
	}
	escreverJSON(w, http.StatusOK, map[string]any{"itens": []itemJSON{}})
}

// O JSON não carrega NaN nem infinito — o decoder já os recusa —, então sobra
// conferir a faixa.
func segundosValidos(v float64) bool {
	return v >= 0 && v <= maxSegundos
}
