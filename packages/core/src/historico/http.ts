import { HistoricoError } from '../ports/historico.js';
import type { HistoricoService, ItemDoHistorico, Marcador } from '../ports/historico.js';
import { leItens } from './fila.js';
import { leMarcador } from './marcador.js';

/** Mesma origem da PWA — sem CORS, e o cookie vai sozinho. */
const ROTA_MARCADOR = '/api/playback';
const ROTA_HISTORICO = '/api/history';

/**
 * O marcador e o histórico da conta, contra a nossa API.
 *
 * Não guarda espelho nenhum, como o `HttpLikesService`: quem guarda é
 * `app/historico.ts`, do lado da web.
 */
export class HttpHistoricoService implements HistoricoService {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    // Embrulhado em vez de `fetchImpl ?? globalThis.fetch`: `fetch` solto perde
    // o `this` do runtime e explode em alguns navegadores.
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async marcador(signal?: AbortSignal): Promise<Marcador | null> {
    const res = await this.pedir(ROTA_MARCADOR, signal ? { signal } : {});
    // 404 é a API que ainda não conhece a rota — a PWA chega ao aparelho antes
    // de o servidor novo subir, e nesse intervalo "sem marcador" é a resposta
    // honesta. Nas ESCRITAS o 404 continua sendo erro: ali ele significa que o
    // marcador não foi guardado, e fingir que foi perderia a posição.
    if (res.status === 404) return null;
    return this.lerMarcador(res);
  }

  async gravarMarcador(m: Marcador, opts?: { keepalive?: boolean }): Promise<Marcador | null> {
    return this.lerMarcador(
      await this.pedir(ROTA_MARCADOR, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(m),
        ...(opts?.keepalive ? { keepalive: true } : {}),
      }),
    );
  }

  async listar(signal?: AbortSignal): Promise<ItemDoHistorico[]> {
    return this.lerItens(await this.pedir(ROTA_HISTORICO, signal ? { signal } : {}));
  }

  async registrar(itens: readonly ItemDoHistorico[]): Promise<ItemDoHistorico[]> {
    return this.lerItens(
      await this.pedir(ROTA_HISTORICO, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itens }),
      }),
    );
  }

  async limpar(): Promise<ItemDoHistorico[]> {
    return this.lerItens(await this.pedir(ROTA_HISTORICO, { method: 'DELETE' }));
  }

  private pedir(rota: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(rota, {
      credentials: 'same-origin',
      ...init,
      headers: { accept: 'application/json', ...init.headers },
    });
  }

  private conferir(res: Response, oQue: string): void {
    if (res.status === 401) throw new HistoricoError('sessão expirada', true);
    if (!res.ok) throw new HistoricoError(`${oQue} respondeu ${res.status}`);
  }

  private async lerMarcador(res: Response): Promise<Marcador | null> {
    this.conferir(res, 'marcador');
    const corpo = (await res.json()) as { marcador?: unknown };
    return leMarcador(corpo.marcador);
  }

  private async lerItens(res: Response): Promise<ItemDoHistorico[]> {
    this.conferir(res, 'histórico');
    const corpo = (await res.json()) as { itens?: unknown };
    return leItens(corpo.itens);
  }
}
