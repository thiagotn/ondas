import { useCallback, useMemo } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';

/**
 * Overlay guardado na query string (`?account=1`, `?shortcuts=1`), e não em
 * estado solto: assim o botão voltar do aparelho fecha o overlay em vez de sair
 * da aba.
 *
 * Só serve para o que NÃO é conteúdo. O player cheio saiu daqui: ele é a rota
 * da faixa (ver `usePlayerOverlay`), porque o endereço tem de dizer qual música
 * está na tela, e não apenas que há uma.
 *
 * Abrir empilha uma entrada no histórico (é isso que dá o "voltar"); fechar
 * usa `replace`, senão sair e entrar de novo encheria o histórico de repetições.
 */
export function useOverlayParam(key: string) {
  const [params, setParams] = useSearchParams();
  // `setSearchParams` chama `navigate` sem `state`, então abrir ou fechar um
  // overlay apagaria a tela de origem que `usePlayerOverlay` guarda ali. Ele
  // repassa as opções de navegação, e é por elas que o `state` atravessa.
  const { state } = useLocation();
  const open = params.get(key) === '1';

  const show = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set(key, '1');
        return next;
      },
      { preventScrollReset: true, state },
    );
  }, [key, setParams, state]);

  const hide = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(key);
        return next;
      },
      { replace: true, preventScrollReset: true, state },
    );
  }, [key, setParams, state]);

  return useMemo(() => ({ open, show, hide }), [open, show, hide]);
}
