import { loadCatalog, type CachedCatalog, type Catalog } from '@ondas/core';
import { useQuery } from '@tanstack/react-query';
import { catalogClient, FORCE_DEMO, kv } from '../app/services';

export const CATALOG_QUERY_KEY = ['catalog', 'trending'] as const;
const META_KEY = 'meta';

/**
 * Catálogo com a cadeia de 3 níveis do handoff (API → metadados locais → demo).
 * A query só embrulha `loadCatalog`: quem decide a origem é `core`.
 */
export function useCatalog() {
  return useQuery<Catalog>({
    queryKey: CATALOG_QUERY_KEY,
    queryFn: () =>
      loadCatalog({
        remote: catalogClient,
        readCache: readMeta,
        // O carimbo dá validade ao nível 2: capa do Audius mora no nó que a
        // guarda, e nó sai da rede — metadados velhos viram capa quebrada.
        writeCache: (tracks) => kv.set<CachedCatalog>(META_KEY, { tracks, savedAt: Date.now() }),
        forceDemo: FORCE_DEMO,
        onError: (err) => console.warn('[ondas] catálogo ao vivo indisponível:', err),
      }),
  });
}

/** Lê o nível 2 descartando o formato antigo (um array solto, sem carimbo). */
async function readMeta(): Promise<CachedCatalog | undefined> {
  const stored = await kv.get<CachedCatalog | unknown[]>(META_KEY);
  if (!stored || Array.isArray(stored)) return undefined;
  return stored;
}
