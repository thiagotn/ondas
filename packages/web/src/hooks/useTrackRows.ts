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
import { useLibrary, usePlayer, useSession } from '../app/stores';
import { useNetwork } from './useNetwork';

export interface RowModel {
  track: Track;
  /** Índice na lista completa — as regras de acesso dependem dele. */
  index: number;
  /** `01`, `02`… ou `▶`/`‖` na faixa atual. */
  idx: string;
  isCurrent: boolean;
  locked: boolean;
  cached: boolean;
  liked: boolean;
  /** ` 42%` enquanto baixa, vazio fora disso. */
  dlLabel: string;
  unavailable: boolean;
  genreColor: string;
  durLabel: string;
  /** Capa pequena da lista, seguida dos nós alternativos. */
  artSources: string[];
  /** Faixa do acervo pessoal — a lista marca com `[meu]`. */
  minha: boolean;
}

/**
 * Converte faixas em linhas prontas para render — o equivalente ao `item()` do
 * protótipo. `visible` é o recorte da aba; `all` dá o índice global.
 */
export function useTrackRows(visible: readonly Track[], all: readonly Track[]): RowModel[] {
  const session = useSession((s) => s.user);
  const { liked, cached, dl } = useLibrary((s) => s);
  const { cur, playing } = usePlayer((s) => s);
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
        locked: isLocked(track, index, session),
        cached: isCached,
        liked: !!liked[track.id],
        dlLabel: progress != null ? dlPct(progress) : '',
        unavailable: offline && !isCached,
        genreColor: genreAnsiVar(track.genre),
        durLabel: fmtTime(track.dur),
        artSources: artworkSources(track.artThumb || track.art, hosts),
        minha: track.source === 'acervo',
      };
    });
  }, [all, cached, cur, dl, liked, offline, playing, session, visible]);
}
