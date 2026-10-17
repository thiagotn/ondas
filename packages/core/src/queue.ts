import { isLocked } from './access.js';
import type { AccessOptions } from './access.js';
import type { Session, Track } from './types.js';

export interface QueueContext {
  tracks: readonly Track[];
  session: Session;
  offline: boolean;
  cached: Readonly<Record<string, boolean>>;
  shuffle: boolean;
  repeat: boolean;
  /** Índice atual, ou -1 quando nada foi carregado. */
  cur: number;
  options?: AccessOptions;
}

/** Tocável: não bloqueada e, se estamos offline, presente no aparelho. */
export function isPlayable(ctx: QueueContext, index: number): boolean {
  const tr = ctx.tracks[index];
  if (!tr) return false;
  if (isLocked(tr, index, ctx.session, ctx.options)) return false;
  if (ctx.offline && !ctx.cached[tr.id]) return false;
  return true;
}

/** Primeira faixa tocável da lista, ou -1 se nenhuma serve. */
export function firstPlayable(ctx: QueueContext): number {
  for (let i = 0; i < ctx.tracks.length; i++) if (isPlayable(ctx, i)) return i;
  return -1;
}

/**
 * Próxima (`dir = 1`) ou anterior (`dir = -1`), pulando faixas não tocáveis.
 * Com shuffle, sorteia a cada tentativa. Retorna -1 quando não há destino.
 * `rnd` é injetável para os testes.
 */
export function stepIndex(ctx: QueueContext, dir: 1 | -1, rnd: () => number = Math.random): number {
  const n = ctx.tracks.length;
  if (!n) return -1;
  let i = ctx.cur < 0 ? -1 : ctx.cur;
  for (let k = 0; k < n; k++) {
    i = ctx.shuffle ? Math.floor(rnd() * n) : (i + dir + n) % n;
    if (isPlayable(ctx, i)) return i;
  }
  return -1;
}

export type EndedAction = { type: 'restart' } | { type: 'play'; index: number } | { type: 'stop' };

/** Fim da faixa: repeat-one reinicia, senão vai para a próxima tocável. */
export function onEnded(ctx: QueueContext, rnd: () => number = Math.random): EndedAction {
  if (ctx.repeat) return { type: 'restart' };
  const next = stepIndex(ctx, 1, rnd);
  return next < 0 ? { type: 'stop' } : { type: 'play', index: next };
}

/** Próxima faixa desbloqueada a pré-carregar (smart buffer). -1 quando não há. */
export function prefetchTarget(ctx: QueueContext, from: number): number {
  const n = ctx.tracks.length;
  for (let k = 1; k < n; k++) {
    const j = (from + k) % n;
    const tr = ctx.tracks[j]!;
    if (isLocked(tr, j, ctx.session, ctx.options)) continue;
    return ctx.cached[tr.id] ? -1 : j;
  }
  return -1;
}

/**
 * Onde a faixa atual ficou na lista nova.
 *
 * `cur` é POSIÇÃO numa lista que muda de tamanho: ao entrar, as faixas do
 * acervo entram na frente; ao sair, elas somem. Sem reancorar, o player
 * passaria a apontar para outra faixa — mostrando uma e tocando outra. O
 * `curId` existe justamente para sobreviver a isso.
 *
 * Devolve -1 quando a faixa não está mais na lista (saiu do acervo, por
 * exemplo), que é o mesmo que "nada carregado" para o resto do código.
 */
export function indexOfTrack(tracks: readonly Track[], id: string | null): number {
  if (!id) return -1;
  return tracks.findIndex((t) => t.id === id);
}
