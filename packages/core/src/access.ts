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

/**
 * Enviar arquivo para o acervo exige conta COM o envio liberado.
 *
 * `!== false`, e não `=== true`: `podeEnviar` ausente é espelho local ou
 * servidor de antes do campo, e ali toda conta enviava (ver `User`). É só o que
 * decide se a tela oferece o painel — a recusa de verdade é do servidor, com
 * `envio_nao_permitido`.
 */
export function canUpload(session: Session): boolean {
  return !!session && session.podeEnviar !== false;
}

export type PlayDenial = 'locked';

export interface PlayabilityContext {
  session: Session;
  options?: AccessOptions;
}

/**
 * Pode tocar? Só o acesso decide — `locked` abre o gate de permissão.
 *
 * **Estar offline não entra aqui, e isso é deliberado.** Havia uma segunda
 * recusa, `not-cached`: sem rede e sem a faixa no aparelho, nem tentava. O
 * problema é a fonte dessa informação — na web ela é `navigator.onLine`, que
 * dá falso negativo. O Android põe o Wi-Fi para dormir com a tela bloqueada e
 * o navegador passa a jurar que não há rede enquanto há.
 *
 * O resultado era o player parar no fim de uma faixa e não ter para onde ir,
 * porque nada mais era "tocável" (ver `queue.ts`). Quem sabe se há rede é o
 * elemento de áudio, tentando: ele tem o próprio evento de erro, e quem chama
 * trata a falha. `navigator.onLine` ficou para o indicador da barra e para não
 * disparar download à toa — não para recusar playback.
 */
export function playability(
  track: Track,
  index: number,
  ctx: PlayabilityContext,
): { ok: true } | { ok: false; reason: PlayDenial } {
  if (isLocked(track, index, ctx.session, ctx.options)) return { ok: false, reason: 'locked' };
  return { ok: true };
}
