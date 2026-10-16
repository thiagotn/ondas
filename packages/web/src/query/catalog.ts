import { loadCatalog, type Catalog, type Track } from '@ondas/core';
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
        readCache: () => kv.get<Track[]>(META_KEY),
        writeCache: (tracks) => kv.set<Track[]>(META_KEY, tracks),
        forceDemo: FORCE_DEMO,
        onError: (err) => console.warn('[ondas] catálogo ao vivo indisponível:', err),
      }),
  });
}
