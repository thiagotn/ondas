package httpapi

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/thiagotn/ondas/api/internal/admin"
)

// O que o painel de admin lê e escreve além de aprovar e negar conta.
//
// Todo texto que sai daqui e veio de fora — a mensagem do pedido de conta, o
// título de uma faixa, o erro de uma ingestão — é DADO não confiável. O painel
// o desenha como texto, nunca como HTML, e a `ondasctl` o limpa de caracteres
// de controle antes de imprimir.

func limiteDaQuery(r *http.Request) int {
	n, _ := strconv.Atoi(r.URL.Query().Get("limite"))
	return n
}

func (s *Server) falhaDeLeitura(w http.ResponseWriter, onde string, err error) {
	slog.Error("admin: "+onde, "erro", err)
	escreverErro(w, http.StatusInternalServerError, "não foi possível ler os dados")
}

func (s *Server) falhaDeEscrita(w http.ResponseWriter, onde string, err error) {
	slog.Error("admin: "+onde, "erro", err)
	escreverErro(w, http.StatusInternalServerError, "não foi possível salvar")
}

func (s *Server) resumoAdmin(w http.ResponseWriter, r *http.Request) {
	resumo, err := s.painel.Resumo(r.Context())
	if err != nil {
		s.falhaDeLeitura(w, "resumo", err)
		return
	}
	escreverJSON(w, http.StatusOK, resumo)
}

// detalharConta devolve a conta com o que é dela: as faixas, com o tamanho de
// cada uma, e as últimas ingestões em que ela aparece (como quem pediu ou como
// destino).
func (s *Server) detalharConta(w http.ResponseWriter, r *http.Request) {
	id, ok := idDaConta(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	conta, err := s.painel.Conta(ctx, id)
	if errors.Is(err, admin.ErrNaoEncontrado) {
		escreverErro(w, http.StatusNotFound, "conta não encontrada")
		return
	}
	if err != nil {
		s.falhaDeLeitura(w, "conta", err)
		return
	}
	faixas, err := s.painel.FaixasDaConta(ctx, id)
	if err != nil {
		s.falhaDeLeitura(w, "faixas da conta", err)
		return
	}
	ingestoes, err := s.painel.Ingestoes(ctx, "", id, 30)
	if err != nil {
		s.falhaDeLeitura(w, "ingestões da conta", err)
		return
	}
	escreverJSON(w, http.StatusOK, map[string]any{
		"conta": conta, "faixas": faixas, "ingestoes": ingestoes,
	})
}

// ajustarConta muda o que a conta pode e quanto ela tem. Todo campo é opcional
// e PONTEIRO, pelo motivo de sempre: ausente é "não mexa", e um corpo sem a
// chave não pode desligar nada.
func (s *Server) ajustarConta(w http.ResponseWriter, r *http.Request) {
	id, ok := idDaConta(w, r)
	if !ok {
		return
	}
	var req struct {
		PodeEnviar     *bool   `json:"podeEnviar"`
		RecebeDoBot    *bool   `json:"recebeDoBot"`
		PlanoID        *string `json:"planoId"`
		CotaExtraBytes *int64  `json:"cotaExtraBytes"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	ajuste := admin.Ajuste{
		PodeEnviar: req.PodeEnviar, RecebeDoBot: req.RecebeDoBot,
		PlanoID: req.PlanoID, CotaExtraBytes: req.CotaExtraBytes,
	}
	if ajuste.Vazio() {
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return
	}
	conta, err := s.painel.AjustarConta(r.Context(), id, ajuste)
	switch {
	case errors.Is(err, admin.ErrNaoEncontrado):
		escreverErro(w, http.StatusNotFound, "conta não encontrada")
		return
	case errors.Is(err, admin.ErrInvalido):
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return
	case err != nil:
		s.falhaDeEscrita(w, "ajustar conta", err)
		return
	}

	var mudou []string
	if req.PodeEnviar != nil {
		mudou = append(mudou, "pode enviar: "+simNao(*req.PodeEnviar))
	}
	if req.RecebeDoBot != nil {
		mudou = append(mudou, "recebe do bot: "+simNao(*req.RecebeDoBot))
	}
	if req.PlanoID != nil {
		mudou = append(mudou, "plano: "+*req.PlanoID)
	}
	if req.CotaExtraBytes != nil {
		mudou = append(mudou, fmt.Sprintf("extra: %d bytes", *req.CotaExtraBytes))
	}
	s.registrar(r, admin.Evento{
		Acao: "conta.ajustada", AlvoTipo: "conta", AlvoID: conta.ID, AlvoRotulo: conta.Email,
		Detalhe: strings.Join(mudou, " · "),
	})
	escreverJSON(w, http.StatusOK, conta)
}

// apagarContaPeloAdmin remove a conta e tudo que é dela, pelo MESMO caminho da
// exclusão feita pelo dono (`apagarContaInteira`): faixas antes, uma a uma, com
// a limpeza do R2 e do que as outras contas guardavam delas.
func (s *Server) apagarContaPeloAdmin(w http.ResponseWriter, r *http.Request) {
	id, ok := idDaConta(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	conta, err := s.painel.Conta(ctx, id)
	if errors.Is(err, admin.ErrNaoEncontrado) {
		escreverErro(w, http.StatusNotFound, "conta não encontrada")
		return
	}
	if err != nil {
		s.falhaDeLeitura(w, "conta", err)
		return
	}
	faixas, err := s.apagarContaInteira(ctx, id)
	if err != nil {
		slog.Error("admin: apagar conta", "conta", id, "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível apagar a conta")
		return
	}
	slog.Info("admin: conta apagada", "conta", id, "faixas", faixas, "ip", clienteIP(r))
	s.registrar(r, admin.Evento{
		Acao: "conta.apagada", AlvoTipo: "conta", AlvoID: id, AlvoRotulo: conta.Email,
		Detalhe: fmt.Sprintf("%d faixa(s)", faixas),
	})
	escreverJSON(w, http.StatusOK, map[string]string{"status": "apagada"})
}

func (s *Server) listarFaixasAdmin(w http.ResponseWriter, r *http.Request) {
	faixas, err := s.painel.Faixas(r.Context(), r.URL.Query().Get("ordem"), limiteDaQuery(r))
	if err != nil {
		s.falhaDeLeitura(w, "faixas", err)
		return
	}
	escreverJSON(w, http.StatusOK, map[string]any{"faixas": faixas})
}

// apagarFaixaPeloAdmin remove uma faixa de qualquer conta, pelo mesmo caminho
// do DELETE feito pelo dono (`apagarFaixa`).
func (s *Server) apagarFaixaPeloAdmin(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if _, err := uuid.Parse(id); err != nil {
		escreverErro(w, http.StatusNotFound, "faixa não encontrada")
		return
	}
	ctx := r.Context()
	dono, titulo, err := s.painel.DonoDaFaixa(ctx, id)
	if errors.Is(err, admin.ErrNaoEncontrado) {
		escreverErro(w, http.StatusNotFound, "faixa não encontrada")
		return
	}
	if err != nil {
		s.falhaDeLeitura(w, "dono da faixa", err)
		return
	}
	if err := s.apagarFaixa(ctx, dono, id); err != nil {
		slog.Error("admin: apagar faixa", "faixa", id, "erro", err)
		escreverErro(w, http.StatusInternalServerError, "não foi possível remover")
		return
	}
	slog.Info("admin: faixa apagada", "faixa", id, "dono", dono, "ip", clienteIP(r))
	s.registrar(r, admin.Evento{Acao: "faixa.apagada", AlvoTipo: "faixa", AlvoID: id, AlvoRotulo: titulo})
	escreverJSON(w, http.StatusOK, map[string]string{"status": "apagada"})
}

func (s *Server) listarIngestoes(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	switch status {
	case "", "pending", "processing", "ready", "error":
	default:
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return
	}
	lista, err := s.painel.Ingestoes(r.Context(), status, "", limiteDaQuery(r))
	if err != nil {
		s.falhaDeLeitura(w, "ingestões", err)
		return
	}
	escreverJSON(w, http.StatusOK, map[string]any{"ingestoes": lista})
}

func (s *Server) lerConfigAdmin(w http.ResponseWriter, r *http.Request) {
	aberto, err := s.painel.CadastroAberto(r.Context())
	if err != nil {
		s.falhaDeLeitura(w, "config", err)
		return
	}
	escreverJSON(w, http.StatusOK, map[string]any{"cadastroAberto": aberto})
}

func (s *Server) gravarConfigAdmin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CadastroAberto *bool `json:"cadastroAberto"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	if req.CadastroAberto == nil {
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return
	}
	if err := s.painel.DefinirCadastroAberto(r.Context(), *req.CadastroAberto); err != nil {
		s.falhaDeEscrita(w, "config", err)
		return
	}
	acao := "cadastro.fechado"
	if *req.CadastroAberto {
		acao = "cadastro.aberto"
	}
	s.registrar(r, admin.Evento{Acao: acao})
	escreverJSON(w, http.StatusOK, map[string]any{"cadastroAberto": *req.CadastroAberto})
}

func (s *Server) listarConvites(w http.ResponseWriter, r *http.Request) {
	convites, err := s.painel.Convites(r.Context())
	if err != nil {
		s.falhaDeLeitura(w, "convites", err)
		return
	}
	escreverJSON(w, http.StatusOK, map[string]any{"convites": convites})
}

// convidar grava o convite: o e-mail que, ao se cadastrar, nasce aprovado.
// Convidar de novo o mesmo e-mail regrava as marcas.
func (s *Server) convidar(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email       string `json:"email"`
		PodeEnviar  bool   `json:"podeEnviar"`
		RecebeDoBot bool   `json:"recebeDoBot"`
		Nota        string `json:"nota"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	convite, err := s.painel.Convidar(r.Context(), admin.Convite{
		Email: req.Email, PodeEnviar: req.PodeEnviar, RecebeDoBot: req.RecebeDoBot, Nota: req.Nota,
	})
	switch {
	case errors.Is(err, admin.ErrInvalido):
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return
	case errors.Is(err, admin.ErrJaExiste):
		// Aqui dizer que o e-mail tem conta não é vazamento: quem pergunta é o
		// admin, que vê a lista de contas inteira.
		escreverErro(w, http.StatusConflict, "e-mail já cadastrado")
		return
	case err != nil:
		s.falhaDeEscrita(w, "convidar", err)
		return
	}
	s.registrar(r, admin.Evento{
		Acao: "convite.criado", AlvoTipo: "convite", AlvoRotulo: convite.Email,
		Detalhe: "pode enviar: " + simNao(convite.PodeEnviar) + " · recebe do bot: " + simNao(convite.RecebeDoBot),
	})
	escreverJSON(w, http.StatusOK, convite)
}

// removerConvite recebe o e-mail na query, e não no caminho: e-mail tem `@`,
// `+` e `.`, e num segmento de URL cada proxy no meio decide por conta própria
// o que decodifica.
func (s *Server) removerConvite(w http.ResponseWriter, r *http.Request) {
	email := strings.TrimSpace(r.URL.Query().Get("email"))
	if email == "" {
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return
	}
	removeu, err := s.painel.RemoverConvite(r.Context(), email)
	if err != nil {
		s.falhaDeEscrita(w, "remover convite", err)
		return
	}
	if !removeu {
		escreverErro(w, http.StatusNotFound, "convite não encontrado")
		return
	}
	s.registrar(r, admin.Evento{
		Acao: "convite.removido", AlvoTipo: "convite", AlvoRotulo: strings.ToLower(email),
	})
	escreverJSON(w, http.StatusOK, map[string]string{"status": "removido"})
}

func (s *Server) listarPlanos(w http.ResponseWriter, r *http.Request) {
	planos, err := s.painel.Planos(r.Context())
	if err != nil {
		s.falhaDeLeitura(w, "planos", err)
		return
	}
	escreverJSON(w, http.StatusOK, map[string]any{"planos": planos})
}

func (s *Server) criarPlano(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID        string `json:"id"`
		Nome      string `json:"nome"`
		CotaBytes *int64 `json:"cotaBytes"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	if req.CotaBytes == nil {
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return
	}
	plano, err := s.painel.CriarPlano(r.Context(), req.ID, req.Nome, *req.CotaBytes)
	switch {
	case errors.Is(err, admin.ErrInvalido):
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return
	case errors.Is(err, admin.ErrJaExiste):
		escreverErro(w, http.StatusConflict, "plano já existe")
		return
	case err != nil:
		s.falhaDeEscrita(w, "criar plano", err)
		return
	}
	s.registrar(r, admin.Evento{
		Acao: "plano.criado", AlvoTipo: "plano", AlvoID: plano.ID, AlvoRotulo: plano.Nome,
		Detalhe: fmt.Sprintf("cota: %d bytes", plano.CotaBytes),
	})
	escreverJSON(w, http.StatusCreated, plano)
}

// atualizarPlano muda nome e/ou cota. Mudar a cota vale na hora para toda
// conta do plano: a cota da conta é calculada, não copiada.
func (s *Server) atualizarPlano(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req struct {
		Nome      *string `json:"nome"`
		CotaBytes *int64  `json:"cotaBytes"`
	}
	if !lerJSON(w, r, &req) {
		return
	}
	if req.Nome == nil && req.CotaBytes == nil {
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return
	}
	plano, err := s.painel.AtualizarPlano(r.Context(), id, req.Nome, req.CotaBytes)
	switch {
	case errors.Is(err, admin.ErrInvalido):
		escreverErro(w, http.StatusBadRequest, "requisição inválida")
		return
	case errors.Is(err, admin.ErrNaoEncontrado):
		escreverErro(w, http.StatusNotFound, "plano não encontrado")
		return
	case err != nil:
		s.falhaDeEscrita(w, "atualizar plano", err)
		return
	}
	s.registrar(r, admin.Evento{
		Acao: "plano.alterado", AlvoTipo: "plano", AlvoID: plano.ID, AlvoRotulo: plano.Nome,
		Detalhe: fmt.Sprintf("cota: %d bytes", plano.CotaBytes),
	})
	escreverJSON(w, http.StatusOK, plano)
}

func (s *Server) listarEventos(w http.ResponseWriter, r *http.Request) {
	eventos, err := s.painel.Eventos(r.Context(), limiteDaQuery(r))
	if err != nil {
		s.falhaDeLeitura(w, "eventos", err)
		return
	}
	escreverJSON(w, http.StatusOK, map[string]any{"eventos": eventos})
}
