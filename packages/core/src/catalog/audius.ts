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
  is_available?: boolean;
  /** Faixa com acesso condicionado (token, compra). É a nossa `[pro]` de verdade. */
  is_stream_gated?: boolean;
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

  /**
   * Faixa da API → `Track`.
   *
   * Existe como método para o trending e o deeplink saírem IDÊNTICOS: duas
   * traduções separadas divergiriam calado, e a faixa aberta por link
   * apareceria diferente da mesma faixa na lista.
   */
  private mapear(t: AudiusTrack, host: string): Track {
    return {
      id: String(t.id),
      title: t.title,
      artist: t.user?.name || '—',
      genre: slugGenre(t.genre),
      dur: t.duration || 0,
      art: t.artwork?.['480x480'] || t.artwork?.['150x150'] || '',
      artThumb: t.artwork?.['150x150'] || t.artwork?.['480x480'] || '',
      stream: `${host}/v1/tracks/${t.id}/stream?app_name=${APP_NAME}`,
      // Explícito, e vindo do gating da própria faixa. Sem isto o `access.ts`
      // cai no heurístico posicional do protótipo (`index % 3`), e a MESMA
      // faixa seria [pro] na lista e livre no link — a posição decidindo o
      // acesso. Ver `isPremium` em `../access.ts`.
      premium: t.is_stream_gated === true,
    };
  }

  /** Tocável? O trending e o link usam a mesma régua. */
  private tocavel(t: AudiusTrack): boolean {
    return t.is_streamable !== false && t.is_available !== false;
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
      return (body.data ?? []).filter((t) => this.tocavel(t)).map((t) => this.mapear(t, host));
    } finally {
      done();
    }
  }

  /**
   * Uma faixa só, pelo id — é o que faz um deeplink abrir uma música que não
   * está nas 24 do trending.
   *
   * `null` significa "não há o que tocar": id que não existe, faixa removida
   * ou não tocável. Erro de rede continua sendo erro, para quem chamou poder
   * distinguir "não existe" de "não deu para saber".
   */
  async track(id: string, options?: TrendingOptions): Promise<Track | null> {
    const { signal, done } = withTimeout(options?.signal, TIMEOUT_MS);
    try {
      const host = await this.resolveHost(signal);
      const res = await this.fetchImpl(
        `${host}/v1/tracks/${encodeURIComponent(id)}?app_name=${APP_NAME}`,
        { signal },
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('audius: faixa falhou (' + res.status + ')');
      const body = (await res.json()) as { data?: AudiusTrack };
      const t = body.data;
      if (!t || !t.id || !this.tocavel(t)) return null;
      return this.mapear(t, host);
    } finally {
      done();
    }
  }

  streamUrl(trackId: string): string | null {
    return this.host ? `${this.host}/v1/tracks/${trackId}/stream?app_name=${APP_NAME}` : null;
  }
}
