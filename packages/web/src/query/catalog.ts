import {
  comFaixasAvulsas,
  loadCatalog,
  showsPublicCatalog,
  type CachedCatalog,
  type Catalog,
} from '@ondas/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useAvulsas } from '../app/extras';
import { acervoClient, catalogClient, FORCE_DEMO, kv } from '../app/services';
import { useSession } from '../app/stores';

export const CATALOG_QUERY_KEY = ['catalog', 'trending'] as const;
const META_KEY = 'meta';

/**
 * Prefixo dos escopos de quem tem conta.
 *
 * Os dois escopos do logado ficam sob ele para que `logout()` e a invalidação
 * do envio alcancem ambos com UMA chave — filtro do TanStack é `exact: false`
 * por padrão. Listar os dois à mão seria uma lista que alguém esquece de
 * atualizar no dia em que aparecer um terceiro.
 */
export const CATALOG_LOGADO_KEY = [...CATALOG_QUERY_KEY, 'logado'] as const;

/**
 * Chave por escopo de sessão E de preferência.
 *
 * Três escopos, não dois: o catálogo do logado tem faixas que o do visitante
 * não pode ter, e o de quem desligou o catálogo público não é o mesmo que o de
 * quem o mantém. Sem o terceiro, desligar serviria a lista misturada anterior
 * do cache até o refetch chegar.
 *
 * Trocar `com-acervo` por `logado/com-publico` deixa a entrada antiga órfã no
 * cache persistido: ela é reidratada, nunca lida e coletada pelo `gcTime` de
 * 24h. O custo é UM boot frio para quem está logado, uma vez, depois do deploy
 * — menos do que bombar o `buster` do persister, que jogaria fora o cache
 * inteiro de todo mundo.
 */
export const catalogKey = (logado: boolean, publico = true) => {
  if (!logado) return [...CATALOG_QUERY_KEY, 'visitante'] as const;
  return [...CATALOG_LOGADO_KEY, publico ? 'com-publico' : 'so-acervo'] as const;
};

/**
 * Catálogo com a cadeia de 3 níveis do handoff (API → metadados locais → demo),
 * mais o acervo próprio quando há sessão. A query só embrulha `loadCatalog`:
 * quem decide a origem é `core`.
 */
export function useCatalog() {
  const user = useSession((s) => s.user);
  const restored = useSession((s) => s.restored);
  const avulsas = useAvulsas((s) => s.list);
  const logado = !!user;
  const publico = showsPublicCatalog(user);

  const query = useQuery<Catalog>({
    // A chave inclui o escopo: entrar ou sair troca de catálogo em vez de
    // reaproveitar o anterior — e o cache persistido do visitante nunca
    // guarda faixa do acervo.
    queryKey: catalogKey(logado, publico),
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
          // A conta desligou o catálogo público: a lista é o acervo e nada
          // mais, e `loadCatalog` nem chega a pedir o trending.
          soAcervo: !publico,
          // Sem sessão não há acervo, e nem vale pedir: a API responderia 401.
          ...(logado ? { acervo: (s?: AbortSignal) => acervoClient.tracks(s) } : {}),
          onError: (err) => console.warn('[ondas] fonte do catálogo indisponível:', err),
        },
        { signal },
      ),
  });

  // As faixas abertas por link entram aqui, e não na query: assim elas
  // sobrevivem ao refetch do trending e ficam fora do cache persistido.
  // Nenhum consumidor precisa saber — todos leem `data.tracks`.
  const data = useMemo(() => comFaixasAvulsas(query.data, avulsas), [query.data, avulsas]);
  return { ...query, data };
}

/** Lê o nível 2 descartando o formato antigo (um array solto, sem carimbo). */
async function readMeta(): Promise<CachedCatalog | undefined> {
  const stored = await kv.get<CachedCatalog | unknown[]>(META_KEY);
  if (!stored || Array.isArray(stored)) return undefined;
  return stored;
}
