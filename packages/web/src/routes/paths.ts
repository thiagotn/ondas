import { librarySegmentSlug, type LibrarySegment, type TabId } from '@ondas/core';

/**
 * Os endereços do app, num lugar só.
 *
 * Eles viviam duplicados entre a tabela de rotas do `App` e o mapa de abas, e
 * `/login` era literal em oito arquivos: divergir era questão de tempo.
 */
export const PATHS = {
  home: '/',
  search: '/search',
  library: '/library',
  login: '/login',
} as const;

export const TAB_PATHS: Record<TabId, string> = {
  home: PATHS.home,
  search: PATHS.search,
  library: PATHS.library,
};

/**
 * Params que são overlay, e não conteúdo: trocar de tela os leva embora.
 *
 * O player cheio NÃO está aqui — ele é um path (`/t/<slug>-<id>`), porque o
 * endereço de uma faixa é o conteúdo em foco, e não um booleano de tela.
 */
export const OVERLAY_PARAMS = ['account', 'shortcuts'] as const;

/** Filtros que moram na query da própria aba. */
export const GENRE_PARAM = 'genre';
export const SEARCH_PARAM = 'q';

/**
 * O recorte da biblioteca no endereço. A palavra sai de `librarySegmentSlug`
 * (core), que é também quem a lê de volta — `acervo` é `archive` ali, porque o
 * id do recorte não é inglês e o path tem de ser.
 */
export const librarySegPath = (seg: LibrarySegment): string =>
  `${PATHS.library}/${librarySegmentSlug(seg)}`;

/**
 * Pathname → aba, ou `undefined` quando o path não é de aba (`/t/...`, `/login`).
 *
 * Não é um `Record` porque `/library/liked` também é a aba da biblioteca.
 */
export function tabForPath(pathname: string): TabId | undefined {
  if (pathname === PATHS.home) return 'home';
  if (pathname === PATHS.search) return 'search';
  if (pathname === PATHS.library || pathname.startsWith(PATHS.library + '/')) return 'library';
  return undefined;
}

/**
 * Tira os overlays de uma URL relativa, para guardá-la como tela de origem.
 *
 * Sem isso, abrir o player com a conta aberta e depois fechá-lo reabriria a
 * conta junto com a tela de trás.
 */
export function semOverlays(url: string): string {
  const [path = '', query] = url.split('?');
  if (!query) return path;
  const params = new URLSearchParams(query);
  for (const key of OVERLAY_PARAMS) params.delete(key);
  const qs = params.toString();
  return path + (qs ? '?' + qs : '');
}
