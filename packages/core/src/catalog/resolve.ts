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
  /**
   * Segunda fonte: as faixas próprias, que só existem logado. Opcional porque
   * o visitante não tem acervo — e porque a cadeia de 3 níveis do catálogo
   * público continua valendo sozinha, exatamente como antes.
   */
  acervo?: (signal?: AbortSignal) => Promise<Track[]>;
}

/**
 * Cadeia de 3 níveis do handoff: API ao vivo → metadados em cache local →
 * catálogo demo. O rótulo devolvido é exibido no comentário do prompt.
 *
 * Com `deps.acervo`, as faixas próprias entram NA FRENTE da lista — é o acervo
 * de quem está logado, e é o que ele quer ver primeiro. A posição é inofensiva
 * para o heurístico `[pro]` do protótipo: faixa do acervo vem com
 * `premium: false` explícito, e o selo só aparece para quem NÃO tem sessão.
 *
 * As duas fontes são buscadas em paralelo e são independentes: acervo fora do
 * ar não derruba o catálogo público, e vice-versa. Quem falha some da lista em
 * vez de virar erro de tela.
 */
export async function loadCatalog(deps: LoadCatalogDeps, options?: TrendingOptions): Promise<Catalog> {
  // Dispara as duas antes de esperar qualquer uma: sequencial somaria as
  // latências sem necessidade.
  const doAcervo = deps.acervo?.(options?.signal);
  const publico = resolvePublico(deps, options);
  const [proprias, catalogo] = await Promise.all([
    doAcervo?.catch((err) => {
      // Visitante sem sessão é o caso normal, não falha: o `semSessao` do
      // AcervoError existe para não poluir o log com o óbvio.
      if (!(err instanceof Error) || !('semSessao' in err) || !err.semSessao) {
        deps.onError?.(err);
      }
      return [] as Track[];
    }) ?? Promise.resolve([] as Track[]),
    publico,
  ]);

  if (!proprias.length) return catalogo;
  return { ...catalogo, tracks: [...proprias, ...catalogo.tracks], acervo: proprias.length };
}

/** A cadeia de 3 níveis do catálogo público, intacta. */
async function resolvePublico(deps: LoadCatalogDeps, options?: TrendingOptions): Promise<Catalog> {
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
