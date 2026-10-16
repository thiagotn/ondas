import { fmtTime } from './format.js';
import type { Catalog, LibrarySegment, Session, TabId, Track } from './types.js';

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
  /** Há um refetch em andamento: o que está na tela ainda é o dado anterior. */
  refreshing?: boolean;
}): PromptLine {
  const { tab, who, genre, q, seg, count, source, refreshing } = args;
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
      cmd: 'ondas ls --' + (seg === 'liked' ? 'curtidas' : 'offline'),
      comment: `${count} itens`,
    };
  }
  return {
    who,
    cwd: '~/em-alta',
    cmd: `ondas trending --genero=${genre}`,
    // Enquanto o refetch não volta, a lista na tela é a da sessão anterior:
    // dizer "ao vivo" sem ressalva seria mentira.
    comment: `${count} faixas · fonte: ${source || '…'}${refreshing ? ' · atualizando' : ''}`,
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

/** `buf:` da status line. */
export function bufferShortLabel(cached: boolean, ahead: number): string {
  return cached ? 'buf: local' : 'buf: +' + fmtTime(ahead);
}
