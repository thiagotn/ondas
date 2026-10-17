import { AuthError } from '../ports/auth.js';
import type { AuthService, Credentials } from '../ports/auth.js';
import type { KeyValueStore } from '../ports/key-value-store.js';
import type { Session, User } from '../types.js';

/** Mesma chave do `LocalAuthService`: a sessão guardada localmente é só um espelho. */
export const SESSION_KEY = 'user';

const ROTAS = {
  login: '/api/auth/login',
  logout: '/api/auth/logout',
  me: '/api/auth/me',
} as const;

interface RespostaUsuario {
  name?: unknown;
  email?: unknown;
}

interface RespostaErro {
  error?: unknown;
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
      // A mensagem da API já vem em pt-BR e é exibida crua na tela de login.
      throw new AuthError(await mensagemDeErro(res));
    }
    const user = leUsuario(await res.json());
    if (!user) throw new AuthError('resposta inesperada do servidor');
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
  if (typeof u.name === 'string' && u.name) return { name: u.name };
  // Resposta sem `name` mas com e-mail ainda dá um nome exibível.
  if (typeof u.email === 'string' && u.email) return { name: u.email.split('@')[0]! };
  return null;
}

async function mensagemDeErro(res: Response): Promise<string> {
  try {
    const corpo = (await res.json()) as RespostaErro;
    if (typeof corpo.error === 'string' && corpo.error) return corpo.error;
  } catch {
    // Resposta sem JSON (um 502 do proxy, por exemplo).
  }
  if (res.status === 429) return 'muitas tentativas — espere alguns minutos';
  if (res.status >= 500) return 'servidor indisponível — tente de novo';
  return 'não foi possível entrar';
}
