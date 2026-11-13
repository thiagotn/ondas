// ondasctl é a CLI de administração do ondas: quem entra na plataforma e quem
// pode enviar arquivo.
//
// Ela só fala HTTP com `/api/admin` — não abre o banco, não lê o ConfigMap, e
// por isso roda de qualquer máquina que alcance a API, sem `kubectl`. É o
// contrário dos subcomandos do `worker` (cors, diag, conferir), que rodam DENTRO
// do cluster com as credenciais dele: aqueles consertam a instalação; esta
// opera o produto, e o que opera o produto tem de passar pela mesma autorização
// que qualquer outro cliente.
//
// Feita para ser chamada por gente e por script (uma skill, um cron): toda
// saída tem `--json`, e o código de saída separa "você usou errado" (2) de "a
// API recusou ou não respondeu" (1).
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"text/tabwriter"
	"time"
	"unicode"
)

const (
	saidaOK   = 0
	saidaErro = 1
	saidaUso  = 2
)

const urlPadrao = "https://music.thiagotn.com"

const ajuda = `ondasctl — administração do ondas

uso:
  ondasctl contas listar  [--status pendente|aprovada|negada|todas] [--json]
  ondasctl contas aprovar <id|e-mail> [--json]
  ondasctl contas negar   <id|e-mail> [--json]
  ondasctl contas envio   <id|e-mail> on|off [--json]

  listar   sem --status mostra a fila: os pedidos em análise, do mais antigo
           para o mais novo.
  aprovar  libera o login da conta. Ela NÃO passa a enviar arquivo.
  negar    recusa o pedido — ou suspende uma conta já aprovada, na hora.
  envio    liga ou desliga o envio de arquivos de uma conta.

ambiente:
  ONDAS_ADMIN_TOKEN        o token de admin, ou
  ONDAS_ADMIN_TOKEN_FILE   o caminho de um arquivo que o contém
  ONDAS_API_URL            a origem da API (padrão: ` + urlPadrao + `)

O token nunca é argumento: argumento aparece no ` + "`ps`" + ` e fica no histórico do shell.

saída: 0 deu certo · 1 a API recusou ou não respondeu · 2 uso ou configuração
`

// conta é o registro como `/api/admin` o devolve (`auth.Conta`, na API). É
// declarado de novo aqui, e não importado, para a CLI não carregar o driver do
// Postgres por causa de oito campos.
type conta struct {
	ID         string     `json:"id"`
	Email      string     `json:"email"`
	Name       string     `json:"name"`
	Status     string     `json:"status"`
	PodeEnviar bool       `json:"podeEnviar"`
	Mensagem   string     `json:"mensagem,omitempty"`
	CriadaEm   time.Time  `json:"criadaEm"`
	DecididoEm *time.Time `json:"decididoEm,omitempty"`
}

// erroDeUso é o erro de quem chamou errado; vira o código de saída 2.
type erroDeUso struct{ msg string }

func (e erroDeUso) Error() string { return e.msg }

func uso(formato string, args ...any) error {
	return erroDeUso{fmt.Sprintf(formato, args...)}
}

type cliente struct {
	base  string
	token string
	http  *http.Client
}

func main() {
	os.Exit(executar(os.Args[1:], os.Getenv, os.Stdout, os.Stderr))
}

// executar é o `main` com as bordas injetadas, para o teste rodar a CLI inteira
// contra um servidor falso sem tocar no ambiente do processo.
func executar(args []string, env func(string) string, out, errOut io.Writer) int {
	if len(args) == 0 || args[0] == "ajuda" || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprint(out, ajuda)
		return saidaOK
	}
	err := despachar(args, env, out)
	if err == nil {
		return saidaOK
	}
	fmt.Fprintln(errOut, "ondasctl:", err)
	var u erroDeUso
	if errors.As(err, &u) {
		fmt.Fprintln(errOut, "veja `ondasctl ajuda`")
		return saidaUso
	}
	return saidaErro
}

func despachar(args []string, env func(string) string, out io.Writer) error {
	if args[0] != "contas" {
		return uso("comando desconhecido: %s", args[0])
	}
	if len(args) < 2 {
		return uso("falta o que fazer com as contas (listar, aprovar, negar, envio)")
	}
	acao := args[1]
	posicionais, emJSON, status, err := separar(args[2:])
	if err != nil {
		return err
	}
	if status != "" && acao != "listar" {
		return uso("--status só vale em `contas listar`")
	}

	// A validação dos argumentos vem ANTES de ler o token: `ondasctl contas
	// aprovar` sem alvo é erro de uso com ou sem configuração.
	switch acao {
	case "listar":
		if len(posicionais) != 0 {
			return uso("`contas listar` não recebe argumento: %s", posicionais[0])
		}
		switch status {
		case "":
			status = "pendente"
		case "todas":
			status = ""
		case "pendente", "aprovada", "negada":
		default:
			return uso("status desconhecido: %s (pendente, aprovada, negada ou todas)", status)
		}
	case "aprovar", "negar":
		if len(posicionais) != 1 {
			return uso("`contas %s` pede um id ou e-mail", acao)
		}
	case "envio":
		if len(posicionais) != 2 || (posicionais[1] != "on" && posicionais[1] != "off") {
			return uso("`contas envio` pede um id ou e-mail e depois `on` ou `off`")
		}
	default:
		return uso("ação desconhecida: contas %s", acao)
	}

	c, err := novoCliente(env)
	if err != nil {
		return err
	}

	if acao == "listar" {
		consulta := url.Values{}
		if status != "" {
			consulta.Set("status", status)
		}
		contas, err := c.listar(consulta)
		if err != nil {
			return err
		}
		if emJSON {
			return escreverJSON(out, contas)
		}
		escreverTabela(out, contas)
		return nil
	}

	id, err := c.resolver(posicionais[0])
	if err != nil {
		return err
	}
	var feita *conta
	switch acao {
	case "aprovar", "negar":
		feita, err = c.pedirConta(http.MethodPost, "/api/admin/contas/"+id+"/"+acao, nil)
	case "envio":
		feita, err = c.pedirConta(http.MethodPatch, "/api/admin/contas/"+id+"/envio",
			map[string]bool{"podeEnviar": posicionais[1] == "on"})
	}
	if err != nil {
		return err
	}
	if emJSON {
		return escreverJSON(out, feita)
	}
	fmt.Fprintf(out, "%s  %s  status=%s  envio=%s\n",
		feita.ID, limpar(feita.Email), feita.Status, simNao(feita.PodeEnviar))
	return nil
}

// separar tira as flags do meio dos argumentos, em qualquer posição.
//
// À mão, e não com o pacote `flag`: ele para na primeira palavra que não é
// flag, e `contas aprovar fulana@… --json` deixaria o `--json` de fora sem
// reclamar. O `cmd/worker` também lê `os.Args` direto.
func separar(args []string) (posicionais []string, emJSON bool, status string, err error) {
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--json":
			emJSON = true
		case a == "--status":
			if i+1 >= len(args) {
				return nil, false, "", uso("--status pede um valor")
			}
			i++
			status = args[i]
		case strings.HasPrefix(a, "--status="):
			status = strings.TrimPrefix(a, "--status=")
		case strings.HasPrefix(a, "-"):
			return nil, false, "", uso("opção desconhecida: %s", a)
		default:
			posicionais = append(posicionais, a)
		}
	}
	return posicionais, emJSON, status, nil
}

func novoCliente(env func(string) string) (*cliente, error) {
	token := strings.TrimSpace(env("ONDAS_ADMIN_TOKEN"))
	if token == "" {
		if caminho := env("ONDAS_ADMIN_TOKEN_FILE"); caminho != "" {
			conteudo, err := os.ReadFile(caminho)
			if err != nil {
				return nil, uso("não consegui ler ONDAS_ADMIN_TOKEN_FILE: %v", err)
			}
			token = strings.TrimSpace(string(conteudo))
		}
	}
	if token == "" {
		return nil, uso("sem token: defina ONDAS_ADMIN_TOKEN ou ONDAS_ADMIN_TOKEN_FILE")
	}
	base := strings.TrimRight(strings.TrimSpace(env("ONDAS_API_URL")), "/")
	if base == "" {
		base = urlPadrao
	}
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, uso("ONDAS_API_URL não é uma origem http(s): %s", base)
	}
	// O token vai num cabeçalho; em http puro ele atravessa a rede em claro. Só
	// a máquina local escapa — é onde a API de desenvolvimento roda.
	if u.Scheme == "http" && !ehLocal(u.Hostname()) {
		return nil, uso("ONDAS_API_URL em http mandaria o token em claro: use https (%s)", base)
	}
	return &cliente{
		base:  base,
		token: token,
		// Não segue redirect: o cliente HTTP do Go reenvia cabeçalhos
		// personalizados para onde for mandado, e o token de admin não pode
		// acabar em outro host por causa de um 302.
		http: &http.Client{
			Timeout: 20 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

func ehLocal(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

var reUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// resolver traduz o alvo da linha de comando em id. Um e-mail vira uma consulta
// a mais; um id passa direto.
func (c *cliente) resolver(alvo string) (string, error) {
	if reUUID.MatchString(alvo) {
		return alvo, nil
	}
	if !strings.Contains(alvo, "@") {
		return "", uso("isto não é um id nem um e-mail: %s", alvo)
	}
	contas, err := c.listar(url.Values{"email": {alvo}})
	if err != nil {
		return "", err
	}
	if len(contas) == 0 {
		return "", fmt.Errorf("nenhuma conta com o e-mail %s", alvo)
	}
	return contas[0].ID, nil
}

func (c *cliente) listar(consulta url.Values) ([]conta, error) {
	caminho := "/api/admin/contas"
	if len(consulta) > 0 {
		caminho += "?" + consulta.Encode()
	}
	var corpo struct {
		Contas []conta `json:"contas"`
	}
	if err := c.pedir(http.MethodGet, caminho, nil, &corpo); err != nil {
		return nil, err
	}
	if corpo.Contas == nil {
		corpo.Contas = []conta{}
	}
	return corpo.Contas, nil
}

func (c *cliente) pedirConta(metodo, caminho string, corpo any) (*conta, error) {
	var feita conta
	if err := c.pedir(metodo, caminho, corpo, &feita); err != nil {
		return nil, err
	}
	return &feita, nil
}

func (c *cliente) pedir(metodo, caminho string, corpo, destino any) error {
	var leitor io.Reader
	if corpo != nil {
		dados, err := json.Marshal(corpo)
		if err != nil {
			return err
		}
		leitor = bytes.NewReader(dados)
	}
	req, err := http.NewRequest(metodo, c.base+caminho, leitor)
	if err != nil {
		return err
	}
	req.Header.Set("X-Ondas-Admin-Token", c.token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "ondasctl")
	if corpo != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("a API não respondeu: %w", err)
	}
	defer resp.Body.Close()
	// Teto de leitura: uma resposta sem fim não vira memória nossa.
	dados, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return fmt.Errorf("lendo a resposta: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return erroDaAPI(resp.StatusCode, dados)
	}
	if err := json.Unmarshal(dados, destino); err != nil {
		return fmt.Errorf("resposta inesperada da API (%d): %w", resp.StatusCode, err)
	}
	return nil
}

// erroDaAPI monta a frase do erro com o que a API disse — e, onde o status
// sozinho não explica, com o que fazer.
func erroDaAPI(status int, dados []byte) error {
	var corpo struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	_ = json.Unmarshal(dados, &corpo)
	switch {
	case status == http.StatusNotFound && corpo.Code == "":
		// O 404 sem corpo JSON é o da administração DESLIGADA: a API finge
		// que a rota não existe quando não tem `ADMIN_TOKEN_SHA256`.
		return errors.New("a API respondeu 404: a administração está desligada nela " +
			"(falta ADMIN_TOKEN_SHA256), ou ONDAS_API_URL não aponta para o ondas")
	case status == http.StatusUnauthorized:
		return errors.New("a API recusou o token de admin (401)")
	case corpo.Error != "":
		return fmt.Errorf("%s (%d)", limpar(corpo.Error), status)
	default:
		return fmt.Errorf("a API respondeu %d", status)
	}
}

func escreverJSON(out io.Writer, valor any) error {
	enc := json.NewEncoder(out)
	enc.SetIndent("", "  ")
	return enc.Encode(valor)
}

func escreverTabela(out io.Writer, contas []conta) {
	if len(contas) == 0 {
		fmt.Fprintln(out, "nenhuma conta")
		return
	}
	w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tE-MAIL\tNOME\tSTATUS\tENVIO\tPEDIDA EM\tMENSAGEM")
	for _, c := range contas {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
			c.ID, limpar(c.Email), limpar(c.Name), c.Status, simNao(c.PodeEnviar),
			c.CriadaEm.Local().Format("2006-01-02 15:04"), limpar(c.Mensagem))
	}
	_ = w.Flush()
}

func simNao(v bool) string {
	if v {
		return "sim"
	}
	return "não"
}

// limpar troca caractere de controle por espaço antes de imprimir.
//
// Nome, e-mail e mensagem são texto de quem PEDIU a conta — de um desconhecido,
// por definição. Sem isto, uma mensagem com sequência de escape reescreveria o
// terminal do admin (e uma com tab ou quebra de linha desmontaria a tabela).
// O `--json` não passa por aqui: lá o encoder já escapa tudo.
func limpar(texto string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, texto)
}
