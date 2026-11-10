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
  /** Índice na lista completa — as regras de acesso dependem dele. `-1` se `fora`. */
  index: number;
  /**
   * A faixa não está no catálogo carregado: a linha é só um RETRATO (título,
   * artista, duração), sem capa nem stream. Só o histórico produz estas — é o
   * único recorte que mostra o que saiu do catálogo (`faixasDoHistorico`).
   *
   * A linha não toca no lugar, porque não há índice para tocar; ela abre o
   * endereço da faixa, que sabe buscá-la por id.
   */
  fora: boolean;
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
  /** Marcada no modo de seleção: a calha mostra `[x]` e o toque marca. */
  marcada: boolean;
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
  const marcadas = useUi((s) => s.marcadas);
  const { offline } = useNetwork();

  return useMemo(() => {
    const indexById = new Map(all.map((t, i) => [t.id, i]));
    // Os hosts do próprio catálogo são a reserva: se um nó cair, outro serve o
    // mesmo CID.
    const hosts = artworkHosts(all);
    return visible.map((track) => {
      // `-1`, e não `0`: com zero, tocar uma linha fora do catálogo tocaria a
      // primeira faixa da lista.
      const index = indexById.get(track.id) ?? -1;
      const fora = index < 0;
      // `index >= 0` porque `cur` também é `-1` com o player vazio — sem isto
      // toda linha de fora apareceria como "a que está tocando".
      const isCurrent = index >= 0 && index === cur;
      const isCached = !!cached[track.id];
      const progress = dl[track.id];
      return {
        track,
        index,
        fora,
        // Sem número na calha: `:08` salta para a faixa 8 do CATÁLOGO, e esta
        // linha não tem lugar nele.
        idx: isCurrent ? (playing ? '▶' : '‖') : fora ? '··' : String(index + 1).padStart(2, '0'),
        isCurrent,
        isCursor: track.id === cursorId,
        locked: !fora && isLocked(track, index, session),
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
        marcada: !!marcadas[track.id],
      };
    });
  }, [all, cached, cur, cursorId, dl, liked, marcadas, offline, playing, session, visible]);
}
