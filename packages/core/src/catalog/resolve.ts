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
  /**
   * A conta desligou o catálogo público: a lista é o acervo e nada mais.
   *
   * Irmão de posição do `forceDemo`, não de significado — aquele troca a fonte
   * pública por outra, este a remove. Quando está ligado, VENCE o `forceDemo`:
   * quem pediu só o acervo não quer catálogo demo no lugar do Audius.
   */
  soAcervo?: boolean;
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
  // O corte vem ANTES de `resolvePublico`, senão o fetch no Audius sai de todo
  // jeito e só o resultado é jogado fora.
  if (deps.soAcervo) return soAcervo(deps, options);

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

/**
 * A lista quando a conta desligou o catálogo público.
 *
 * Nada de `readCache`, `writeCache` nem catálogo demo: não houve falha nenhuma,
 * e cair no demo aqui seria inventar faixa para quem pediu só a dela. O nível 2
 * também não entra — ele guarda metadado público, que é justamente o que esta
 * lista não tem.
 *
 * E aqui a falha do acervo **rejeita**, ao contrário da regra de cima, onde
 * quem falha some da lista. O inverso vale porque o número de fontes mudou: com
 * duas, sumir é degradação e a tela continua útil; com uma, resolver vazio
 * faria a consulta sobrescrever o cache persistido com lista vazia — boot sem
 * rede viraria app em branco, e as faixas baixadas desapareceriam de
 * `--offline` com os bytes ainda no aparelho. Rejeitando, quem chama mantém o
 * dado anterior e pode dizer que falhou.
 */
async function soAcervo(deps: LoadCatalogDeps, options?: TrendingOptions): Promise<Catalog> {
  const proprias = (await deps.acervo?.(options?.signal)) ?? [];
  return { tracks: proprias, source: 'só o acervo', acervo: proprias.length };
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

/** Teto de faixas avulsas numa sessão: abrir muitos links não faz a lista crescer sem fim. */
export const MAX_AVULSAS = 20;

/**
 * Junta ao catálogo as faixas abertas por link que não estão na lista.
 *
 * Elas entram NO FIM, nunca na frente, por dois motivos: a frente é o lugar do
 * acervo (contrato acima, e `catalog.acervo` conta quantas são), e prepender
 * reembaralharia os índices de todo mundo — o que muda quem é `[pro]` no
 * catálogo demo e remonta a lista inteira na tela.
 */
export function comFaixasAvulsas(
  catalog: Catalog | undefined,
  avulsas: readonly Track[],
): Catalog | undefined {
  if (!catalog || !avulsas.length) return catalog;
  const jaTem = new Set(catalog.tracks.map((t) => t.id));
  const novas = avulsas.filter((t) => !jaTem.has(t.id)).slice(0, MAX_AVULSAS);
  if (!novas.length) return catalog;
  return { ...catalog, tracks: [...catalog.tracks, ...novas] };
}
