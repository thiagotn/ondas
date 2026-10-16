import type { Catalog, Track } from '../types.js';
import type { CatalogClient, TrendingOptions } from './client.js';
import { demoTracks } from './demo.js';

export interface LoadCatalogDeps {
  /** Nível 1: metadados ao vivo. */
  remote: CatalogClient;
  /** Nível 2: metadados da última sessão (idb/localStorage). */
  readCache: () => Promise<Track[] | undefined>;
  /** Grava os metadados frescos para o nível 2 da próxima vez. */
  writeCache: (tracks: Track[]) => Promise<void>;
  /** Força o catálogo demo (flag de dev). */
  forceDemo?: boolean;
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
    if (cached && cached.length) return { tracks: cached, source: 'metadados em cache local' };
    return { tracks: demoTracks(), source: 'catálogo demo — api inacessível' };
  }
}
