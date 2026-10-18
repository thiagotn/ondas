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
  /** Posição sob o dedo/mouse enquanto o botão está pressionado. */
  const [arrasto, setArrasto] = useState<number | null>(null);
  const caixa = useRef<HTMLButtonElement>(null);
  const bars = useLarguraEmBarras(caixa);

  const picos = useMemo(() => {
    const medidos = decodificarPicos(peaks);
    return medidos ? reamostrarPicos(medidos, bars) : picosLisos(bars);
  }, [peaks, bars]);

  // Durante o arrasto a barra mostra o ponto escolhido, não onde o áudio
  // está: sem isso o desenho continuaria correndo por baixo do dedo.
  const pos = arrasto ?? played;
  const d = useMemo(() => wavePaths(picos, pos, buf, mirror), [picos, pos, buf, mirror]);

  const fracaoDoEvento = (e: { clientX: number; currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  // Marca do ponteiro: onde o dedo está agora, ou onde o mouse paira.
  const marca = arrasto ?? hover;

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
      // `pos` e não `played`: durante o arrasto o valor do controle é o que
      // está sob o dedo, que é também o que está desenhado.
      aria-valuenow={Math.round(pos * 100)}
      className={className ? `${s.wave} ${className}` : s.wave}
      // Nada de `onClick` para posicionar: clique é um caso particular de
      // arrasto (encostar e soltar no mesmo ponto), e tratar os dois aqui
      // evita procurar duas vezes na mesma solta. O clique ainda é parado
      // para não subir até a linha do rodapé, que abre o player.
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        // Só o botão principal; o direito abre menu e o do meio cola.
        if (!e.isPrimary || e.button !== 0) return;
        e.stopPropagation();
        // Captura: o dedo sai da caixa no meio do arrasto o tempo todo — num
        // rodapé de 40px de altura isso é a regra, não a exceção. Com ela os
        // eventos continuam chegando aqui até soltar.
        e.currentTarget.setPointerCapture(e.pointerId);
        setArrasto(fracaoDoEvento(e));
      }}
      onPointerMove={(e) => {
        if (arrasto !== null) {
          setArrasto(fracaoDoEvento(e));
          return;
        }
        // Só o mouse paira. No toque, a marca aparece ao encostar e some ao
        // soltar — senão o cursor ficaria plantado no último lugar tocado.
        if (e.pointerType === 'mouse') setHover(fracaoDoEvento(e));
      }}
      onPointerUp={(e) => {
        if (arrasto === null) return;
        e.stopPropagation();
        // A faixa anda uma vez só, ao soltar. Procurar a cada movimento faz
        // o áudio engasgar: cada pulo numa faixa que vem pela rede é um
        // pedido novo de intervalo de bytes.
        onSeek(fracaoDoEvento(e));
        setArrasto(null);
        if (e.pointerType !== 'mouse') setHover(null);
      }}
      onPointerCancel={() => {
        // O navegador decidiu que o gesto era rolagem vertical (ver
        // `touch-action` no CSS). Nada de procurar: o dedo não estava aqui.
        setArrasto(null);
        setHover(null);
      }}
      onPointerLeave={() => {
        if (arrasto === null) setHover(null);
      }}
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
      {marca !== null && (
        <span className={s.cursor} style={{ left: `${(marca * 100).toFixed(2)}%` }}>
          {dur ? <span className={s.cursorTempo}>{fmtTime(marca * dur)}</span> : null}
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
