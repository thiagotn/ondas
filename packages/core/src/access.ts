import type { Session, Track } from './types.js';

export interface AccessOptions {
  /** Heurístico do protótipo quando a API não informa `premium`: cada N-ésima faixa é [pro]. */
  premiumEvery?: number;
}

export const DEFAULT_PREMIUM_EVERY = 3;

/** Faixa [pro]. Prefere o campo da API; cai no heurístico do protótipo quando ausente. */
export function isPremium(track: Track, index: number, opts?: AccessOptions): boolean {
  if (typeof track.premium === 'boolean') return track.premium;
  const n = opts?.premiumEvery ?? DEFAULT_PREMIUM_EVERY;
  return n > 0 && index % n === n - 1;
}

/** Bloqueada para este usuário: [pro] sem sessão. */
export function isLocked(track: Track, index: number, session: Session, opts?: AccessOptions): boolean {
  return !session && isPremium(track, index, opts);
}

/** Downloads offline exigem conta. */
export function canDownload(session: Session): boolean {
  return !!session;
}

export type PlayDenial = 'locked' | 'not-cached';

export interface PlayabilityContext {
  session: Session;
  offline: boolean;
  cached: Readonly<Record<string, boolean>>;
  options?: AccessOptions;
}

/**
 * Pode tocar? `locked` abre o gate de permissão; `not-cached` é só um toast
 * (sem rede e a faixa não está no aparelho).
 */
export function playability(
  track: Track,
  index: number,
  ctx: PlayabilityContext,
): { ok: true } | { ok: false; reason: PlayDenial } {
  if (isLocked(track, index, ctx.session, ctx.options)) return { ok: false, reason: 'locked' };
  if (ctx.offline && !ctx.cached[track.id]) return { ok: false, reason: 'not-cached' };
  return { ok: true };
}
