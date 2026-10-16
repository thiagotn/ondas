import { hash } from './format.js';
import type { WaveBar } from './types.js';

export const BLOCKS = '▁▂▃▄▅▆▇█';

/** Barra da waveform grande/pequena: altura determinística pelo id da faixa. */
export function waveBars(
  trackId: string | null | undefined,
  n: number,
  played: number,
  buf: number,
): WaveBar[] {
  const h = hash(trackId ?? 'x');
  const out: WaveBar[] = [];
  for (let i = 0; i < n; i++) {
    const v = Math.abs(Math.sin(h * 0.0001 + i * 0.55) * 0.6 + Math.sin(i * 0.17 + (h % 7)) * 0.4);
    const f = (i + 0.5) / n;
    out.push({
      ch: BLOCKS[Math.min(7, Math.floor(v * 8))]!,
      color:
        f <= played ? 'var(--color-accent)'
        : f <= buf ? 'var(--color-neutral-500)'
        : 'var(--color-neutral-800)',
    });
  }
  return out;
}

/** Quantidade de barras da waveform grande: 34 no wide, ajustada à viewport no narrow. */
export function barCount(viewportWidth: number, wide: boolean): number {
  if (wide) return 34;
  return Math.max(16, Math.floor((Math.min(viewportWidth, 980) - 66) / 13.3));
}

/** Barras da waveform da player row. */
export function miniBarCount(wide: boolean): number {
  return wide ? 60 : 22;
}

/** Barra de buffer do full player: 24 caracteres `█` tocado / `▓` em buffer / `░` resto. */
export const BUFFER_BAR_LEN = 24;

export function bufferBar(played: number, buf: number): { a: string; b: string; c: string } {
  const a = Math.round(Math.min(1, Math.max(0, played)) * BUFFER_BAR_LEN);
  const b = Math.max(0, Math.round(Math.min(1, Math.max(0, buf)) * BUFFER_BAR_LEN) - a);
  return {
    a: '█'.repeat(a),
    b: '▓'.repeat(b),
    c: '░'.repeat(Math.max(0, BUFFER_BAR_LEN - a - b)),
  };
}
