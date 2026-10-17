import { loadCatalog, type CachedCatalog, type Catalog } from '@ondas/core';
import { useQuery } from '@tanstack/react-query';
import { acervoClient, catalogClient, FORCE_DEMO, kv } from '../app/services';
import { useSession } from '../app/stores';

export const CATALOG_QUERY_KEY = ['catalog', 'trending'] as const;
const META_KEY = 'meta';

/** Chave por escopo de sessão: o catálogo do logado tem faixas que o do visitante não pode ter. */
export const catalogKey = (logado: boolean) =>
  [...CATALOG_QUERY_KEY, logado ? 'com-acervo' : 'visitante'] as const;

/**
 * Catálogo com a cadeia de 3 níveis do handoff (API → metadados locais → demo),
 * mais o acervo próprio quando há sessão. A query só embrulha `loadCatalog`:
 * quem decide a origem é `core`.
 */
export function useCatalog() {
  const user = useSession((s) => s.user);
  const restored = useSession((s) => s.restored);
  const logado = !!user;

  return useQuery<Catalog>({
    // A chave inclui o escopo: entrar ou sair troca de catálogo em vez de
    // reaproveitar o anterior — e o cache persistido do visitante nunca
    // guarda faixa do acervo.
    queryKey: catalogKey(logado),
    // Esperar a sessão ser restaurada evita buscar o catálogo de visitante e
    // logo depois o de logado, no boot de quem já tem conta.
    enabled: restored,
    queryFn: ({ signal }) =>
      loadCatalog(
        {
          remote: catalogClient,
          readCache: readMeta,
          // O carimbo dá validade ao nível 2: capa do Audius mora no nó que a
          // guarda, e nó sai da rede — metadados velhos viram capa quebrada.
          writeCache: (tracks) => kv.set<CachedCatalog>(META_KEY, { tracks, savedAt: Date.now() }),
          forceDemo: FORCE_DEMO,
          // Sem sessão não há acervo, e nem vale pedir: a API responderia 401.
          ...(logado ? { acervo: (s?: AbortSignal) => acervoClient.tracks(s) } : {}),
          onError: (err) => console.warn('[ondas] fonte do catálogo indisponível:', err),
        },
        { signal },
      ),
  });
}

/** Lê o nível 2 descartando o formato antigo (um array solto, sem carimbo). */
async function readMeta(): Promise<CachedCatalog | undefined> {
  const stored = await kv.get<CachedCatalog | unknown[]>(META_KEY);
  if (!stored || Array.isArray(stored)) return undefined;
  return stored;
}
