import {
  artworkHosts,
  artworkSources,
  dlPct,
  fmtTime,
  genreAnsiVar,
  isLocked,
  type Track,
} from '@ondas/core';
import { useMemo } from 'react';
import { useLibrary, usePlayer, useSession, useUi } from '../app/stores';
import { useNetwork } from './useNetwork';

export interface RowModel {
  track: Track;
  /** Índice na lista completa — as regras de acesso dependem dele. */
  index: number;
  /** `01`, `02`… ou `▶`/`‖` na faixa atual. */
  idx: string;
  isCurrent: boolean;
  /** Linha marcada pelo cursor (`j`/`k`, `:08`) — não é a que está tocando. */
  isCursor: boolean;
  locked: boolean;
  cached: boolean;
  liked: boolean;
  /** A curtida é da conta: sem sessão o coração não liga. */
  canLike: boolean;
  /** ` 42%` enquanto baixa, vazio fora disso. */
  dlLabel: string;
  unavailable: boolean;
  genreColor: string;
  durLabel: string;
  /** Capa pequena da lista, seguida dos nós alternativos. */
  artSources: string[];
  /** Faixa do acervo pessoal — a lista marca com `[meu]`. */
  minha: boolean;
  /**
   * Nome de quem compartilhou, vazio quando a faixa é minha ou é do catálogo
   * público. A lista marca com `[de <nome>]`, onde marcaria `[meu]`.
   */
  owner: string;
}

/**
 * Converte faixas em linhas prontas para render — o equivalente ao `item()` do
 * protótipo. `visible` é o recorte da aba; `all` dá o índice global.
 */
export function useTrackRows(visible: readonly Track[], all: readonly Track[]): RowModel[] {
  const session = useSession((s) => s.user);
  const { liked, cached, dl } = useLibrary((s) => s);
  const { cur, playing } = usePlayer((s) => s);
  const cursorId = useUi((s) => s.cursorId);
  const { offline } = useNetwork();

  return useMemo(() => {
    const indexById = new Map(all.map((t, i) => [t.id, i]));
    // Os hosts do próprio catálogo são a reserva: se um nó cair, outro serve o
    // mesmo CID.
    const hosts = artworkHosts(all);
    return visible.map((track) => {
      const index = indexById.get(track.id) ?? 0;
      const isCurrent = index === cur;
      const isCached = !!cached[track.id];
      const progress = dl[track.id];
      return {
        track,
        index,
        idx: isCurrent ? (playing ? '▶' : '‖') : String(index + 1).padStart(2, '0'),
        isCurrent,
        isCursor: track.id === cursorId,
        locked: isLocked(track, index, session),
        cached: isCached,
        liked: !!liked[track.id],
        canLike: !!session,
        dlLabel: progress != null ? dlPct(progress) : '',
        unavailable: offline && !isCached,
        genreColor: genreAnsiVar(track.genre),
        durLabel: fmtTime(track.dur),
        artSources: artworkSources(track.artThumb || track.art, hosts),
        // `[meu]` é sobre ser MINHA, não sobre vir do acervo: uma faixa que
        // outra pessoa compartilhou vem do acervo e não é minha, e marcá-la
        // `[meu]` seria dizer o contrário do que a tela quer dizer.
        minha: track.source === 'acervo' && !track.owner,
        owner: track.source === 'acervo' ? (track.owner ?? '') : '',
      };
    });
  }, [all, cached, cur, cursorId, dl, liked, offline, playing, session, visible]);
}
