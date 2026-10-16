import type { Catalog, Track } from '../types.js';
import type { CatalogClient, TrendingOptions } from './client.js';
import { demoTracks } from './demo.js';

/** Metadados guardados do nível 2, com a hora em que foram salvos. */
export interface CachedCatalog {
  tracks: Track[];
  savedAt: number;
}

/**
 * Validade do cache de metadados. Passou disso, o catálogo volta ao demo em vez
 * de insistir: as URLs de capa apontam para nós específicos do Audius, que saem
 * da rede com o tempo — metadados velhos viram uma lista de capas quebradas.
 */
export const CATALOG_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;

export interface LoadCatalogDeps {
  /** Nível 1: metadados ao vivo. */
  remote: CatalogClient;
  /** Nível 2: metadados da última sessão (idb/localStorage). */
  readCache: () => Promise<CachedCatalog | undefined>;
  /** Grava os metadados frescos para o nível 2 da próxima vez. */
  writeCache: (tracks: Track[]) => Promise<void>;
  /** Força o catálogo demo (flag de dev). */
  forceDemo?: boolean;
  /** Validade do nível 2; o padrão é `CATALOG_CACHE_MAX_AGE_MS`. */
  maxAgeMs?: number;
  /** Injetável para teste. */
  now?: () => number;
  onError?: (err: unknown) => void;
}

/**
 * Cadeia de 3 níveis do handoff: API ao vivo → metadados em cache local →
 * catálogo demo. O rótulo devolvido é exibido no comentário do prompt.
 */
export async function loadCatalog(deps: LoadCatalogDeps, options?: TrendingOptions): Promise<Catalog> {
  if (deps.forceDemo) return { tracks: demoTracks(), source: 'catálogo demo' };
  try {
    const tracks = await deps.remote.trending(options);
    if (!tracks.length) throw new Error('catálogo vazio');
    await deps.writeCache(tracks);
    return { tracks, source: 'audius api (ao vivo)' };
  } catch (err) {
    deps.onError?.(err);
    const cached = await deps.readCache().catch(() => undefined);
    const idade = (deps.now?.() ?? Date.now()) - (cached?.savedAt ?? 0);
    if (cached?.tracks.length && idade <= (deps.maxAgeMs ?? CATALOG_CACHE_MAX_AGE_MS)) {
      return { tracks: cached.tracks, source: 'metadados em cache local' };
    }
    return { tracks: demoTracks(), source: 'catálogo demo — api inacessível' };
  }
}
