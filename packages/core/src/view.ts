import { fmtBytes, fmtTime } from './format.js';
import type { Catalog, LibrarySegment, Session, TabId, Track } from './types.js';

/**
 * Os três recortes da biblioteca, na ordem em que a tela os mostra.
 *
 * Aqui, e não na tela: eles viraram endereço (`/library/offline`), e o que
 * entra pela URL é texto de fora — precisa de uma peneira testável.
 */
export const LIBRARY_SEGMENTS: readonly LibrarySegment[] = ['liked', 'offline', 'acervo'];

/**
 * A palavra de cada recorte na URL.
 *
 * Duas delas são o próprio id; `acervo` vira `archive` porque todo path do app
 * é inglês. O id NÃO acompanha: ele é o mesmo valor que a API emite em
 * `Track.source` (`api/internal/httpapi/acervo.go`) e que o chip `--acervo`
 * anuncia na tela — traduzir o id para casar com a URL exigiria traduzir os
 * dois, e um deles não é nosso.
 */
const SEGMENT_SLUGS: Record<LibrarySegment, string> = {
  liked: 'liked',
  offline: 'offline',
  acervo: 'archive',
};

/** Recorte → a palavra dele na URL. */
export function librarySegmentSlug(seg: LibrarySegment): string {
  return SEGMENT_SLUGS[seg];
}

/**
 * O recorte que `/library` sem segmento significa.
 *
 * Com conta é `acervo`: a biblioteca é onde ficam as faixas que são da pessoa,
 * e é o recorte que o envio alimenta — abrir em `--curtidas` pedia um clique
 * antes de mostrar o que ela tem. Sem conta o acervo não existe: o catálogo não
 * traz faixa própria nenhuma e o chip nem é desenhado (`LibraryRoute`), então
 * ali o padrão volta a ser `liked`, que vive no aparelho e não pede servidor.
 *
 * Aqui, e não na tela, porque é a mesma regra que decide duas coisas: onde
 * `/library` abre e onde cai um segmento que não existe.
 */
export function defaultLibrarySegment(user: Session): LibrarySegment {
  return user ? 'acervo' : 'liked';
}

/**
 * Palavra da URL → recorte da biblioteca; o que não é uma das três vale
 * `padrao` — na tela, o de `defaultLibrarySegment`.
 *
 * Normaliza em silêncio em vez de dar tela de erro: `/library/lixo` é um
 * endereço digitado errado, não uma falha a explicar. O que ele NÃO pode fazer
 * é atravessar para dentro do app — sem isto, `promptLine` escreveria
 * `ondas ls --lixo` no prompt e a lista mostraria o recorte errado. Pela mesma
 * régua, `/library/acervo` (a palavra velha) cai no padrão: paths em português
 * não redirecionam, eles simplesmente não existem mais.
 */
export function parseLibrarySegment(
  raw: string | undefined,
  padrao: LibrarySegment,
): LibrarySegment {
  return LIBRARY_SEGMENTS.find((seg) => SEGMENT_SLUGS[seg] === raw) ?? padrao;
}

/** `tudo` + até 8 gêneros presentes no catálogo, na ordem em que aparecem. */
export function genreOptions(tracks: readonly Track[]): string[] {
  return ['tudo', ...[...new Set(tracks.map((t) => t.genre))].slice(0, 8)];
}

export interface ListQuery {
  tracks: readonly Track[];
  tab: TabId;
  q: string;
  genre: string;
  seg: LibrarySegment;
  liked: Readonly<Record<string, boolean>>;
  cached: Readonly<Record<string, boolean>>;
}

/** A lista visível na aba atual. Busca casa título + artista + gênero, ignorando `#` inicial. */
export function visibleTracks(v: ListQuery): Track[] {
  if (v.tab === 'home') {
    return v.tracks.filter((t) => v.genre === 'tudo' || t.genre === v.genre);
  }
  if (v.tab === 'search') {
    const q = v.q.trim().toLowerCase().replace(/^#/, '');
    if (!q) return v.tracks.slice(0, 8);
    return v.tracks.filter((t) => `${t.title} ${t.artist} ${t.genre}`.toLowerCase().includes(q));
  }
  // `acervo` não olha estado local: curtida e offline são marcas que o
  // aparelho guarda, e o acervo é o que a conta tem. Daí o filtro ser a
  // procedência da faixa, posta pelo adaptador em `catalog/acervo.ts`.
  if (v.seg === 'acervo') return v.tracks.filter((t) => t.source === 'acervo');
  return v.tracks.filter((t) => (v.seg === 'liked' ? v.liked[t.id] : v.cached[t.id]));
}

export interface PromptLine {
  who: string;
  cwd: string;
  cmd: string;
  comment: string;
}

/** A linha de prompt e o comentário `#` de cada aba. */
export function promptLine(args: {
  tab: TabId;
  who: string;
  genre: string;
  q: string;
  seg: LibrarySegment;
  count: number;
  source: Catalog['source'] | '';
  /** Quantas faixas próprias entraram na lista (ver `Catalog.acervo`). */
  acervo?: number;
  /** Há um refetch em andamento: o que está na tela ainda é o dado anterior. */
  refreshing?: boolean;
}): PromptLine {
  const { tab, who, genre, q, seg, count, source, acervo, refreshing } = args;
  if (tab === 'search') {
    const typed = q.trim().replace(/^#/, '');
    return {
      who,
      cwd: '~/buscar',
      cmd: 'ondas search ' + (q ? `"${q}"` : ''),
      comment: typed ? `${count} resultados` : 'sugestões — digite para filtrar',
    };
  }
  if (tab === 'library') {
    return {
      who,
      cwd: '~/biblioteca',
      cmd: 'ondas ls --' + (seg === 'liked' ? 'curtidas' : seg),
      comment: `${count} itens`,
    };
  }
  return {
    who,
    cwd: '~/em-alta',
    cmd: `ondas trending --genero=${genre}`,
    // Enquanto o refetch não volta, a lista na tela é a da sessão anterior:
    // dizer "ao vivo" sem ressalva seria mentira. E quando o acervo entra, a
    // fonte deixa de ser uma só — dizer apenas "audius" esconderia metade.
    comment:
      `${count} faixas · fonte: ${source || '…'}` +
      (acervo ? ` + acervo (${acervo})` : '') +
      (refreshing ? ' · atualizando' : ''),
  };
}

/** Texto de lista vazia, por aba e contexto de sessão. */
export function emptyText(args: {
  tab: TabId;
  seg: LibrarySegment;
  q: string;
  loading: boolean;
  user: Session;
}): string {
  const { tab, seg, q, loading, user } = args;
  if (tab === 'search') return `grep: nenhum resultado para "${q}"`;
  if (tab === 'library') {
    if (seg === 'liked') return 'vazio — pressione [l] ou o coração para curtir.';
    if (seg === 'acervo') {
      return user ? 'vazio — envie um arquivo com [+ arquivo].' : 'o acervo exige login.';
    }
    return user
      ? 'vazio — baixe faixas [d] ou ative o buffer para ouvir sem rede.'
      : 'downloads offline exigem login.';
  }
  return loading ? '' : 'nenhuma faixa.';
}

/** Linha `fonte:` do painel de buffer do full player. */
export function bufferSourceLabel(args: {
  cached: boolean;
  downloading: number | null;
  hasStream: boolean;
  ahead: number;
}): string {
  if (args.cached) return 'arquivo local — toca sem rede';
  if (args.downloading != null) {
    return `baixando ${Math.round(args.downloading * 100)}% → disponível offline`;
  }
  return (args.hasStream ? 'stream · ' : 'prévia · ') + fmtTime(args.ahead) + ' em buffer à frente';
}

/**
 * Linha `espaço` do painel de conta.
 *
 * O número que importa é quanto ainda CABE — é com ele que se decide se dá
 * para baixar o mix de uma hora. O total aparece junto só para dar escala.
 *
 * `quota` é opcional de propósito: nem todo navegador informa o limite, e
 * inventar um seria pior que dizer que não se sabe.
 */
export function storageLabel(uso: { bytes: number; quota?: number } | null): string {
  if (!uso) return 'calculando…';
  if (uso.quota == null) {
    return fmtBytes(uso.bytes) + ' usados · o navegador não informa o limite';
  }
  const livres = Math.max(0, uso.quota - uso.bytes);
  return `${fmtBytes(livres)} livres de ${fmtBytes(uso.quota)}`;
}

/** `buf:` da status line. */
export function bufferShortLabel(cached: boolean, ahead: number): string {
  return cached ? 'buf: local' : 'buf: +' + fmtTime(ahead);
}
