import { useCallback, useEffect, useRef } from 'react';

/** Quanto tempo segurar. É o mesmo do Android, e o que o dedo já espera. */
const PRESSAO_MS = 450;
/** Arrastar mais que isto é rolagem, não pressão. */
const TOLERANCIA_PX = 10;

export interface ToqueLongo {
  /** Para espalhar no elemento que recebe a pressão. */
  handlers: {
    onPointerDown(e: React.PointerEvent): void;
    onPointerUp(): void;
    onPointerMove(e: React.PointerEvent): void;
    onPointerCancel(): void;
    onPointerLeave(): void;
  };
  /**
   * Chamar no `onClick`: devolve `true` quando aquele clique é o rastro de uma
   * pressão que já agiu, e portanto deve ser engolido.
   *
   * Existe porque o navegador dispara `click` no `pointerup` de todo jeito —
   * sem engolir, segurar uma faixa marcaria E tocaria a música.
   */
  consumiuClique(): boolean;
}

/**
 * Toque longo: segurar o elemento por um tempo dispara `acao`.
 *
 * Em `pointer` e não em `touch`, de propósito: o mesmo gesto vale para o dedo,
 * para a caneta e para o botão do mouse segurado — e no desktop sem teclado ele
 * é a única porta para a marcação.
 *
 * O que NÃO está aqui é bloqueio de `contextmenu`. A casca já desliga seleção
 * de texto e o callout do iOS (`global.css`), que é o que faz segurar uma linha
 * não virar "copiar"; bloquear o evento no JS mataria o clique direito no
 * desktop, e há um teste de ponta a ponta que fixa essa escolha.
 */
export function useToqueLongo(acao: () => void): ToqueLongo {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origem = useRef<{ x: number; y: number } | null>(null);
  const disparou = useRef(false);

  const cancelar = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    origem.current = null;
  }, []);

  // Timer pendente num componente que saiu da tela (trocou de recorte com o
  // dedo na linha) agiria sobre uma lista que não existe mais.
  useEffect(() => cancelar, [cancelar]);

  return {
    handlers: {
      onPointerDown: (e) => {
        // Só o botão principal: o direito do mouse abre o menu do navegador, e
        // segurar para abrir o menu não é pedir para marcar.
        if (e.button !== 0) return;
        cancelar();
        disparou.current = false;
        origem.current = { x: e.clientX, y: e.clientY };
        timer.current = setTimeout(() => {
          timer.current = null;
          disparou.current = true;
          // Confirmação no dedo. O gesto não tem nada na tela anunciando que
          // existe, então ele precisa responder no instante em que pega.
          navigator.vibrate?.(10);
          acao();
        }, PRESSAO_MS);
      },
      onPointerMove: (e) => {
        if (!origem.current) return;
        const longe =
          Math.abs(e.clientX - origem.current.x) > TOLERANCIA_PX ||
          Math.abs(e.clientY - origem.current.y) > TOLERANCIA_PX;
        if (longe) cancelar();
      },
      onPointerUp: cancelar,
      onPointerCancel: cancelar,
      onPointerLeave: cancelar,
    },
    consumiuClique: () => {
      if (!disparou.current) return false;
      disparou.current = false;
      return true;
    },
  };
}
