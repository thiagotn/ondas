import { slugGenre } from '../format.js';
import type { Track } from '../types.js';
import type { CatalogClient, TrendingOptions } from './client.js';

const DISCOVERY = 'https://api.audius.co';
const APP_NAME = 'ONDAS';
const TIMEOUT_MS = 8000;

interface AudiusTrack {
  id: string;
  title: string;
  genre?: string;
  duration?: number;
  is_streamable?: boolean;
  user?: { name?: string };
  artwork?: Record<string, string>;
}

/** Combina o sinal do chamador com um timeout próprio. */
function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), ms);
  const onAbort = () => ctl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctl.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * API pública do Audius: descobre os hosts, escolhe um ao acaso e lê o trending.
 * Mantém o mapeamento do protótipo (artwork 480x480, gênero slugificado).
 */
export class AudiusCatalogClient implements CatalogClient {
  private host: string | null = null;
  private readonly fetchImpl: typeof fetch;

  /**
   * `fetch` precisa ser chamado com o objeto global como `this` (no navegador,
   * guardar a referência nua e invocá-la como método dá "Illegal invocation"),
   * por isso o padrão é um wrapper em vez da função direta.
   */
  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  private async resolveHost(signal: AbortSignal): Promise<string> {
    if (this.host) return this.host;
    const res = await this.fetchImpl(DISCOVERY, { signal });
    if (!res.ok) throw new Error('audius: discovery falhou (' + res.status + ')');
    const body = (await res.json()) as { data?: string[] };
    const hosts = body.data ?? [];
    if (!hosts.length) throw new Error('audius: nenhum host disponível');
    this.host = hosts[Math.floor(Math.random() * hosts.length)]!;
    return this.host;
  }

  async trending(options?: TrendingOptions): Promise<Track[]> {
    const { signal, done } = withTimeout(options?.signal, TIMEOUT_MS);
    try {
      const host = await this.resolveHost(signal);
      const limit = options?.limit ?? 24;
      const res = await this.fetchImpl(
        `${host}/v1/tracks/trending?app_name=${APP_NAME}&limit=${limit}`,
        { signal },
      );
      if (!res.ok) throw new Error('audius: trending falhou (' + res.status + ')');
      const body = (await res.json()) as { data?: AudiusTrack[] };
      return (body.data ?? [])
        .filter((t) => t.is_streamable !== false)
        .map((t) => ({
          id: String(t.id),
          title: t.title,
          artist: t.user?.name || '—',
          genre: slugGenre(t.genre),
          dur: t.duration || 0,
          art: t.artwork?.['480x480'] || t.artwork?.['150x150'] || '',
          stream: `${host}/v1/tracks/${t.id}/stream?app_name=${APP_NAME}`,
        }));
    } finally {
      done();
    }
  }

  streamUrl(trackId: string): string | null {
    return this.host ? `${this.host}/v1/tracks/${trackId}/stream?app_name=${APP_NAME}` : null;
  }
}
