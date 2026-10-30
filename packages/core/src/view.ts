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
 * Se o catálogo público entra na lista.
 *
 * Visitante: sempre. Ele não tem conta onde guardar a escolha, e o catálogo
 * público é a única fonte que existe para ele.
 *
 * Com conta, é o campo `publico` do usuário — lido como `!== false`, e não como
 * `=== true`. A diferença é o caso que importa: `restore()` devolve o espelho
 * local sem validar quando não há rede, e um espelho gravado antes deste campo
 * existir não o tem. Com `=== true`, esse `undefined` apagaria o catálogo
 * público de quem nunca pediu isso, justamente offline, onde não há como
 * corrigir. Um `true` errado custa um toque; um `false` errado esconde o
 * catálogo E as faixas públicas curtidas e baixadas, sem causa visível.
 *
 * Aqui, e não na tela, porque é o único lugar que decide: a chave da consulta,
 * a fonte do catálogo, a linha do prompt e os textos de vazio leem desta função.
 */
export function showsPublicCatalog(user: Session): boolean {
  return user ? user.publico !== false : true;
}

/**
 * Quantos itens o recorte guarda no aparelho mas a lista não mostra.
 *
 * `--curtidas` e `--offline` filtram o catálogo carregado, então uma faixa
 * pública curtida ou baixada sai da tela quando a conta desliga o catálogo
 * público — o estado continua salvo, e os bytes também. Este número é o que
 * deixa o texto de vazio dizer isso em vez de mentir "vazio — baixe faixas".
 */
export function hiddenInSegment(
  seg: LibrarySegment,
  marks: Pick<ListQuery, 'liked' | 'cached'>,
  tracks: readonly Track[],
): number {
  if (seg === 'acervo') return 0;
  const naLista = new Set(tracks.map((t) => t.id));
  const ids = Object.keys(seg === 'liked' ? marks.liked : marks.cached);
  return ids.filter((id) => !naLista.has(id)).length;
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
    //
    // Com `só o acervo` a contagem NÃO é anexada: ela já é o número à esquerda,
    // e `fonte: só o acervo (13)` em `13 faixas` seria a mesma conta duas
    // vezes. O `+ acervo (N)` existe para dizer quanto da lista misturada é
    // próprio, e aqui não há mistura.
    comment:
      `${count} faixas · fonte: ${source || '…'}` +
      (acervo && source !== 'só o acervo' ? ` + acervo (${acervo})` : '') +
      (refreshing ? ' · atualizando' : ''),
  };
}

/**
 * Texto de lista vazia, por aba e contexto de sessão.
 *
 * `hidden` e `publicOff` existem para a lista vazia não contradizer o resto da
 * tela: com o catálogo público desligado, `ondas whoami` continua dizendo
 * "7 faixas · 54 MB" (ele conta o estado do aparelho, não o catálogo) enquanto
 * `--offline` mostraria "vazio — baixe faixas [d]". A frase tem de dizer o que
 * aconteceu de verdade.
 */
export function emptyText(args: {
  tab: TabId;
  seg: LibrarySegment;
  q: string;
  loading: boolean;
  user: Session;
  /** O catálogo público está desligado nesta conta (`showsPublicCatalog`). */
  publicOff?: boolean;
  /** Itens do recorte que estão no aparelho mas fora da lista (`hiddenInSegment`). */
  hidden?: number;
}): string {
  const { tab, seg, q, loading, user, publicOff, hidden } = args;
  if (tab === 'search') return `grep: nenhum resultado para "${q}"`;
  if (tab === 'library') {
    // O recorte tem coisa guardada, e ela está fora da lista porque o catálogo
    // público saiu — não porque não há nada.
    if (publicOff && hidden) {
      const quantas = hidden === 1 ? '1 faixa aqui vem' : `${hidden} faixas aqui vêm`;
      return `${quantas} do catálogo público, que está desligado — religue em [ondas whoami].`;
    }
    if (seg === 'liked') return 'vazio — pressione [l] ou o coração para curtir.';
    if (seg === 'acervo') {
      return user ? 'vazio — envie um arquivo com [+ arquivo].' : 'o acervo exige login.';
    }
    return user
      ? 'vazio — baixe faixas [d] ou ative o buffer para ouvir sem rede.'
      : 'downloads offline exigem login.';
  }
  if (loading) return '';
  // em-alta vazia com o catálogo público desligado não é "nenhuma faixa": é o
  // acervo ainda vazio. A frase genérica mandaria a pessoa procurar o que não
  // existe, em vez de dizer os dois caminhos que ela tem.
  if (publicOff) return 'o acervo está vazio — envie um arquivo em ~/biblioteca.';
  return 'nenhuma faixa.';
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
