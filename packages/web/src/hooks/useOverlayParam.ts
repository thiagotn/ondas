import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Overlay guardado na query string (`?player=1`, `?conta=1`), e não em estado
 * solto: assim o botão voltar do aparelho fecha o overlay em vez de sair da
 * aba — e o endereço na barra diz o que está na tela.
 *
 * Abrir empilha uma entrada no histórico (é isso que dá o "voltar"); fechar
 * usa `replace`, senão sair e entrar de novo encheria o histórico de repetições.
 */
export function useOverlayParam(key: string) {
  const [params, setParams] = useSearchParams();
  const open = params.get(key) === '1';

  const show = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set(key, '1');
        return next;
      },
      { preventScrollReset: true },
    );
  }, [key, setParams]);

  const hide = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(key);
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  }, [key, setParams]);

  return useMemo(() => ({ open, show, hide }), [open, show, hide]);
}
