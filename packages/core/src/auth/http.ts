import type { ErroDaApi } from '../types.js';
import { AuthError } from '../ports/auth.js';
import type {
  AuthService,
  Credentials,
  PedidoDeConta,
  ResultadoDoPedido,
} from '../ports/auth.js';
import type { KeyValueStore } from '../ports/key-value-store.js';
import { lePrefs, type PrefsDaConta } from '../prefs.js';
import type { Session, User } from '../types.js';

/** Mesma chave do `LocalAuthService`: a sessão guardada localmente é só um espelho. */
export const SESSION_KEY = 'user';

const ROTAS = {
  login: '/api/auth/login',
  logout: '/api/auth/logout',
  me: '/api/auth/me',
  prefs: '/api/auth/prefs',
  signup: '/api/auth/signup',
  conta: '/api/auth/conta',
  senha: '/api/auth/senha',
  apagar: '/api/auth/conta/apagar',
} as const;

interface RespostaUsuario {
  name?: unknown;
  email?: unknown;
  publico?: unknown;
  prefs?: unknown;
  podeEnviar?: unknown;
}

interface RespostaErro {
  error?: unknown;
  code?: unknown;
  params?: unknown;
}

/**
 * Auth de verdade, contra a nossa API.
 *
 * A sessão mora num cookie `HttpOnly` que este código não consegue ler — e é
 * de propósito: script nenhum alcança o token, nem um XSS. O que fica no
 * `KeyValueStore` é apenas o nome do usuário, para a tela não piscar entre o
 * boot e a resposta do `/me`.
 *
 * Troca o `LocalAuthService` sem a UI saber: as duas implementam `AuthService`.
 */
export class HttpAuthService implements AuthService {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly store: KeyValueStore,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async login(credentials: Credentials): Promise<User> {
    const res = await this.pedir(ROTAS.login, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credentials),
    });

    if (!res.ok) {
      // A frase da API continua vindo em pt-BR e é a RESERVA; o que a tela
      // prefere é o código, que ela traduz. Ver `erros.go` na API.
      const { msg, erro } = await recusa(res);
      throw new AuthError(msg, erro);
    }
    const user = leUsuario(await res.json());
    if (!user)
      throw new AuthError('resposta inesperada do servidor', {
        codigo: 'resposta_inesperada',
      });
    await this.store.set(SESSION_KEY, user);
    return user;
  }

  async logout(): Promise<void> {
    // O espelho local sai primeiro: se a rede falhar no meio, o que o usuário
    // pediu (sair) já valeu na tela. O cookie expira sozinho de todo jeito.
    await this.store.remove(SESSION_KEY);
    try {
      await this.pedir(ROTAS.logout, { method: 'POST' });
    } catch {
      // Sem rede não há como limpar o cookie agora; o `/me` do próximo boot
      // resolve. Não é motivo para a tela acusar erro.
    }
  }

  /**
   * Sessão atual, segundo o servidor — com uma exceção importante.
   *
   * Sem rede, `restore()` devolve o espelho local em vez de derrubar a sessão.
   * A PWA é instalada e abre offline: deslogar alguém porque o avião está no ar
   * seria transformar falta de rede em logout. Só um **401** invalida, porque
   * só ele significa "o servidor disse que não".
   */
  async restore(): Promise<Session> {
    const local = (await this.store.get<User>(SESSION_KEY)) ?? null;
    try {
      const res = await this.pedir(ROTAS.me);
      if (res.status === 401) {
        await this.store.remove(SESSION_KEY);
        return null;
      }
      if (!res.ok) return local;
      const user = leUsuario(await res.json());
      if (!user) return local;
      await this.store.set(SESSION_KEY, user);
      return user;
    } catch {
      return local;
    }
  }

  /**
   * Liga ou desliga o catálogo público da conta.
   *
   * Regravar o espelho é metade do trabalho, não um detalhe: é o espelho que
   * `restore()` devolve quando não há rede, então sem esta linha o próximo boot
   * offline voltaria à preferência velha e a lista mudaria sozinha.
   *
   * O 401 entra pela mesma porta do 401 do `restore()` — a sessão morreu com a
   * pessoa olhando o painel, e tratar isso como "falhou, tente de novo"
   * deixaria o botão parecendo instável em vez de mandá-la para o login.
   */
  async setPublico(on: boolean): Promise<User> {
    return this.gravarPrefs({ publico: on });
  }

  /**
   * Grava preferências de aparência na conta — parcial: o que não vem fica.
   *
   * A mesma rota, o mesmo 401 e o mesmo espelho de `setPublico`, e pela mesma
   * razão: é o espelho que `restore()` devolve sem rede, então é ele que faz o
   * próximo boot offline abrir com o que a conta tem.
   */
  async setPrefs(parcial: PrefsDaConta, opts?: { keepalive?: boolean }): Promise<User> {
    return this.gravarPrefs({ prefs: parcial }, opts?.keepalive ? { keepalive: true } : {});
  }

  /**
   * Pede uma conta. NÃO grava espelho quando o pedido fica em análise: não há
   * sessão, e um espelho ali faria o próximo boot offline abrir "logado" numa
   * conta que o servidor ainda não deixou entrar.
   *
   * O que separa os dois desfechos é o status HTTP — 202 em análise, 201 já
   * aprovada (allowlist) —, e não o corpo: um proxy que devolvesse 200 com
   * outra coisa não pode virar "pedido recebido".
   */
  async signup(pedido: PedidoDeConta): Promise<ResultadoDoPedido> {
    const mensagem = pedido.mensagem?.trim();
    const res = await this.pedir(ROTAS.signup, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: pedido.name.trim(),
        email: pedido.email,
        password: pedido.password,
        ...(mensagem ? { mensagem } : {}),
      }),
    });
    if (!res.ok) {
      const { msg, erro } = await recusa(res, FALHA_CRIAR_CONTA);
      throw new AuthError(msg, erro);
    }
    if (res.status === 202) return { status: 'pendente' };
    const user = res.status === 201 ? leUsuario(await res.json()) : null;
    if (!user)
      throw new AuthError('resposta inesperada do servidor', {
        codigo: 'resposta_inesperada',
      });
    await this.store.set(SESSION_KEY, user);
    return { status: 'aprovada', user };
  }

  /** Troca o nome de exibição. O espelho acompanha, como em `setPublico`. */
  async renomear(name: string): Promise<User> {
    const res = await this.pedirDaConta(ROTAS.conta, 'PATCH', { name });
    const user = leUsuario(await res.json());
    if (!user)
      throw new AuthError('resposta inesperada do servidor', {
        codigo: 'resposta_inesperada',
      });
    await this.store.set(SESSION_KEY, user);
    return user;
  }

  async trocarSenha(atual: string, nova: string): Promise<void> {
    await this.pedirDaConta(ROTAS.senha, 'POST', { atual, nova });
  }

  /**
   * Apaga a conta no servidor. O espelho só sai DEPOIS do aceite: senha errada
   * ou rede fora deixam a pessoa exatamente onde estava, logada.
   */
  async apagarConta(senha: string): Promise<void> {
    await this.pedirDaConta(ROTAS.apagar, 'POST', { senha });
    await this.store.remove(SESSION_KEY);
  }

  /**
   * Um pedido de conta com sessão: o 401 derruba o espelho (a sessão morreu com
   * a pessoa olhando o painel), e qualquer outra recusa vira `AuthError` com o
   * código da API.
   */
  private async pedirDaConta(rota: string, method: string, corpo: unknown): Promise<Response> {
    const res = await this.pedir(rota, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    if (res.status === 401) {
      await this.store.remove(SESSION_KEY);
      throw new AuthError('sessão expirada', { codigo: 'sessao_expirada' });
    }
    if (!res.ok) {
      const { msg, erro } = await recusa(res, FALHA_SALVAR_CONTA);
      throw new AuthError(msg, erro);
    }
    return res;
  }

  private async gravarPrefs(corpo: unknown, init: RequestInit = {}): Promise<User> {
    const res = await this.pedir(ROTAS.prefs, {
      ...init,
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    if (res.status === 401) {
      await this.store.remove(SESSION_KEY);
      throw new AuthError('sessão expirada', { codigo: 'sessao_expirada' });
    }
    if (!res.ok) {
      // Uma leitura só: `res.json()` consome o corpo, e um segundo `recusa`
      // cairia no catch e inventaria o erro genérico.
      const { msg, erro } = await recusa(res);
      throw new AuthError(msg, erro);
    }
    const user = leUsuario(await res.json());
    if (!user)
      throw new AuthError('resposta inesperada do servidor', {
        codigo: 'resposta_inesperada',
      });
    await this.store.set(SESSION_KEY, user);
    return user;
  }

  private pedir(rota: string, init?: RequestInit): Promise<Response> {
    return this.fetchImpl(rota, {
      // Mesma origem: o cookie vai sozinho. Explícito para não depender do
      // padrão de nenhum runtime.
      credentials: 'same-origin',
      ...init,
      headers: { accept: 'application/json', ...init?.headers },
    });
  }
}

function leUsuario(bruto: unknown): User | null {
  if (!bruto || typeof bruto !== 'object') return null;
  const u = bruto as RespostaUsuario;
  // `publico` entra SÓ quando o servidor manda um booleano. Omitir em vez de
  // preencher um padrão aqui mantém o padrão num lugar só
  // (`showsPublicCatalog`), e é o que deixa um servidor antigo — ou um corpo
  // estranho — significar o estado de hoje em vez de "desligado".
  //
  // `prefs` segue a mesma regra, e a ausência aqui carrega ainda mais: sem a
  // chave, o servidor é de antes das preferências, e quem lê `undefined` não
  // manda nenhuma para ele (ver `decidirPrefs`). Preencher `{}` faria um
  // servidor antigo parecer um que nunca recebeu escolha — e o aparelho tentaria
  // subir as suas para uma rota que as recusa.
  const pref = {
    ...(typeof u.publico === 'boolean' ? { publico: u.publico } : {}),
    ...(u.prefs && typeof u.prefs === 'object' ? { prefs: lePrefs(u.prefs) } : {}),
    // A mesma regra de `publico`: só o booleano entra, e a ausência (servidor
    // de antes do campo) continua significando "pode" — ver `canUpload`.
    ...(typeof u.podeEnviar === 'boolean' ? { podeEnviar: u.podeEnviar } : {}),
  };
  if (typeof u.name === 'string' && u.name) return { name: u.name, ...pref };
  // Resposta sem `name` mas com e-mail ainda dá um nome exibível.
  if (typeof u.email === 'string' && u.email) {
    return { name: u.email.split('@')[0]!, ...pref };
  }
  return null;
}

/**
 * Lê a recusa da API: a frase (reserva) e o código (o que se traduz).
 *
 * Sem JSON — um 502 do proxy — não há código, e o status vira um código local
 * para a tela não ficar sem o que dizer em en e es.
 */
async function recusa(
  res: Response,
  reserva: { msg: string; erro: ErroDaApi } = FALHA_ENTRAR,
): Promise<{ msg: string; erro: ErroDaApi }> {
  try {
    const corpo = (await res.json()) as RespostaErro;
    const codigo = typeof corpo.code === 'string' && corpo.code ? corpo.code : undefined;
    const params =
      corpo.params && typeof corpo.params === 'object'
        ? (corpo.params as Record<string, unknown>)
        : undefined;
    if (typeof corpo.error === 'string' && corpo.error) {
      return { msg: corpo.error, erro: { codigo, params } };
    }
  } catch {
    // Resposta sem JSON (um 502 do proxy, por exemplo).
  }
  if (res.status === 429) {
    return {
      msg: 'muitas tentativas — espere alguns minutos',
      erro: { codigo: 'muitas_tentativas' },
    };
  }
  if (res.status >= 500) {
    return {
      msg: 'servidor indisponível — tente de novo',
      erro: { codigo: 'servidor_indisponivel' },
    };
  }
  return reserva;
}

// A última reserva de `recusa`, para a recusa que veio sem JSON e sem um status
// que diga algo: cada operação tem a sua, senão o cadastro que falhou diria
// "não foi possível entrar".
const FALHA_ENTRAR = { msg: 'não foi possível entrar', erro: { codigo: 'falha_entrar' } };
const FALHA_CRIAR_CONTA = {
  msg: 'não foi possível criar a conta',
  erro: { codigo: 'falha_criar_conta' },
};
const FALHA_SALVAR_CONTA = {
  msg: 'não foi possível salvar a conta',
  erro: { codigo: 'falha_salvar_conta' },
};
