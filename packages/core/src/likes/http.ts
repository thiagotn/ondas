import { LikesError } from '../ports/likes.js';
import type { LikesService } from '../ports/likes.js';

/** Mesma origem da PWA — sem CORS, e o cookie vai sozinho. */
const ROTA = '/api/likes';

interface Resposta {
  ids?: unknown;
}

/**
 * As curtidas da conta, contra a nossa API.
 *
 * Não guarda espelho nenhum: quem guarda é o `libraryStore`, que já é a fonte
 * do render e já persiste. Este adaptador só fala com o servidor.
 */
export class HttpLikesService implements LikesService {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    // Embrulhado em vez de `fetchImpl ?? globalThis.fetch`: `fetch` solto perde
    // o `this` do runtime e explode em alguns navegadores.
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async list(signal?: AbortSignal): Promise<string[]> {
    return this.ler(await this.pedir(signal ? { signal } : {}));
  }

  async apply(add: readonly string[], remove: readonly string[]): Promise<string[]> {
    return this.ler(
      await this.pedir({
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ add, remove }),
      }),
    );
  }

  private pedir(init: RequestInit): Promise<Response> {
    return this.fetchImpl(ROTA, {
      credentials: 'same-origin',
      ...init,
      headers: { accept: 'application/json', ...init.headers },
    });
  }

  private async ler(res: Response): Promise<string[]> {
    if (res.status === 401) throw new LikesError('sessão expirada', true);
    if (!res.ok) throw new LikesError(`curtidas responderam ${res.status}`);
    const corpo = (await res.json()) as Resposta;
    // Peneira defensiva, como a do acervo: isto é JSON que atravessou rede e
    // cache, e um id que não é string viraria uma chave `undefined` no store.
    if (!Array.isArray(corpo.ids)) return [];
    return corpo.ids.filter((id): id is string => typeof id === 'string' && !!id);
  }
}
