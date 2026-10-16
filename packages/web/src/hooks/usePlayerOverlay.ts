import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * O full player é um overlay guardado na query string (`?player=1`), e não um
 * estado solto: assim o botão voltar do aparelho fecha o player em vez de sair
 * da aba.
 */
export function usePlayerOverlay() {
  const [params, setParams] = useSearchParams();
  const isPlayerOpen = params.get('player') === '1';

  const openPlayer = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('player', '1');
        return next;
      },
      { preventScrollReset: true },
    );
  }, [setParams]);

  const closePlayer = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('player');
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  }, [setParams]);

  return { isPlayerOpen, openPlayer, closePlayer };
}
