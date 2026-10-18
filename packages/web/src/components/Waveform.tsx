import {
  barCount,
  decodificarPicos,
  fmtTime,
  picosLisos,
  reamostrarPicos,
  wavePaths,
} from '@ondas/core';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import s from './waveform.module.css';

export interface WaveformProps {
  /** Picos medidos, como vêm da API. Ausente = barra lisa. */
  peaks: string | undefined;
  /** Fração tocada, 0..1. */
  played: number;
  /** Fração em buffer, 0..1. */
  buf: number;
  onSeek(fraction: number): void;
  /** Reflexo embaixo. Só no player cheio, onde há altura para ele. */
  mirror?: boolean;
  /**
   * Duração da faixa. Quando vem, passar o ponteiro mostra o tempo daquele
   * ponto antes de clicar — a razão de desenhar a forma é poder mirar nela.
   */
  dur?: number;
  className?: string;
  label?: string;
}

/** Passo do teclado, em fração da faixa. 2% de uma faixa de 4min são ~5s. */
const PASSO_TECLA = 0.02;

/**
 * Forma de onda da faixa — a única barra de progresso do app, grande e
 * pequena. Clicar, arrastar o dedo ou usar as setas posiciona a faixa.
 */
export function Waveform({
  peaks,
  played,
  buf,
  onSeek,
  mirror = false,
  dur,
  className,
  label,
}: WaveformProps) {
  const [hover, setHover] = useState<number | null>(null);
  const caixa = useRef<HTMLButtonElement>(null);
  const bars = useLarguraEmBarras(caixa);

  const picos = useMemo(() => {
    const medidos = decodificarPicos(peaks);
    return medidos ? reamostrarPicos(medidos, bars) : picosLisos(bars);
  }, [peaks, bars]);

  const d = useMemo(() => wavePaths(picos, played, buf, mirror), [picos, played, buf, mirror]);

  const fracaoDoEvento = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  return (
    <button
      ref={caixa}
      type="button"
      // `slider` em vez de `button`: o leitor de tela anuncia a posição e as
      // setas, que é o que este controle faz. O elemento continua sendo um
      // `<button>` para chegar o foco e o alvo de toque de graça.
      role="slider"
      aria-label={label ?? 'Posição da faixa'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(played * 100)}
      className={className ? `${s.wave} ${className}` : s.wave}
      onClick={(e) => {
        e.stopPropagation();
        onSeek(fracaoDoEvento(e));
      }}
      onMouseMove={(e) => setHover(fracaoDoEvento(e))}
      onMouseLeave={() => setHover(null)}
      onKeyDown={(e) => {
        const passo =
          e.key === 'ArrowRight' ? PASSO_TECLA
          : e.key === 'ArrowLeft' ? -PASSO_TECLA
          : 0;
        if (passo) {
          e.preventDefault();
          e.stopPropagation();
          onSeek(Math.min(1, Math.max(0, played + passo)));
          return;
        }
        if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          e.stopPropagation();
          onSeek(e.key === 'Home' ? 0 : 1);
        }
      }}
    >
      <svg
        className={s.svg}
        viewBox={`0 0 ${d.largura} ${d.altura}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path className={s.resto} d={d.resto} />
        <path className={s.buffer} d={d.buffer} />
        <path className={s.tocado} d={d.tocado} />
        {mirror && (
          <g className={s.eco}>
            <path className={s.resto} d={d.ecoResto} />
            <path className={s.buffer} d={d.ecoBuffer} />
            <path className={s.tocado} d={d.ecoTocado} />
          </g>
        )}
      </svg>
      {hover !== null && (
        <span className={s.cursor} style={{ left: `${(hover * 100).toFixed(2)}%` }}>
          {dur ? <span className={s.cursorTempo}>{fmtTime(hover * dur)}</span> : null}
        </span>
      )}
    </button>
  );
}

/**
 * Quantas barras cabem na caixa, medindo a caixa.
 *
 * O desenho precisa de uma barra a cada três pixels; derivar isso da largura
 * da viewport (como a versão em caracteres fazia) erra sempre que o player
 * não ocupa a tela inteira — que é o caso do rodapé e da coluna do player
 * cheio. Antes da primeira medida vale um palpite: o `ResizeObserver` corrige
 * no mesmo quadro.
 */
function useLarguraEmBarras(ref: React.RefObject<HTMLElement | null>): number {
  const [barras, setBarras] = useState(64);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const medir = () => setBarras(barCount(el.getBoundingClientRect().width));
    medir();
    if (typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver(medir);
    obs.observe(el);
    return () => obs.disconnect();
  }, [ref]);

  return barras;
}
