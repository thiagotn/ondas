import { waveBars } from '@ondas/core';
import { useMemo } from 'react';

export interface WaveformProps {
  trackId: string | null;
  /** Quantidade de barras. */
  bars: number;
  /** Fração tocada, 0..1. */
  played: number;
  /** Fração em buffer, 0..1. */
  buf: number;
  onSeek(fraction: number): void;
  className?: string;
  label?: string;
}

/**
 * Waveform em caracteres de bloco (`▁▂▃▄▅▆▇█`). Clicar posiciona a faixa —
 * é a única barra de progresso do app, grande e pequena.
 */
export function Waveform({ trackId, bars, played, buf, onSeek, className, label }: WaveformProps) {
  const data = useMemo(() => waveBars(trackId, bars, played, buf), [trackId, bars, played, buf]);

  return (
    <span
      role="slider"
      tabIndex={-1}
      aria-label={label ?? 'Posição da faixa'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(played * 100)}
      className={className}
      onClick={(e) => {
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
      }}
    >
      {data.map((bar, i) => (
        <span key={i} style={{ color: bar.color }}>
          {bar.ch}
        </span>
      ))}
    </span>
  );
}
