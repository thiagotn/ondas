import { parseTrackPath, trackPath } from '@ondas/core';
import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import * as controller from '../app/controller';
import { PATHS, semOverlays } from '../routes/paths';

/**
 * O full player é a rota da faixa (`/t/<slug>-<id>`) — a mesma do link que se
 * manda para alguém —, e não um `?player=1`.
 *
 * O param era um booleano: ele dizia que o player estava aberto e não qual
 * faixa estava na tela. Com o endereço sendo o da faixa, compartilhar virou
 * copiar a barra de endereços, e um reload reconstrói a música em vez de abrir
 * um overlay sobre nada (o `playerStore` não é persistido).
 *
 * Abrir empilha uma entrada no histórico, que é o que faz o botão voltar
 * fechar o player; fechar volta à tela de origem com `replace`, senão sair e
 * entrar de novo encheria o histórico de repetições.
 */
export function usePlayerOverlay() {
  const navigate = useNavigate();
  const { pathname, search, state } = useLocation();
  const isPlayerOpen = !!parseTrackPath(pathname);

  const openPlayer = useCallback(() => {
    // A faixa sai do controller, e não de `useCurrentTrack`: isto roda num
    // handler de evento, e o hook assinaria o catálogo em todo componente que
    // só quer o botão. `currentTrack()` já devolve `undefined` sem faixa, o
    // que dispensa o guarda `cur >= 0` de quem chama.
    const track = controller.currentTrack();
    // Já aberto: um push do mesmo path empilharia duas entradas iguais, e o
    // voltar precisaria de dois toques para fechar uma tela só.
    if (isPlayerOpen || !track) return;
    navigate(trackPath(track), { state: { from: semOverlays(pathname + search) } });
  }, [isPlayerOpen, navigate, pathname, search]);

  const closePlayer = useCallback(() => {
    // A tela de origem vem do histórico, e não de um `navigate(-1)`: com a
    // conta aberta por cima, o `show()` dela empilhou outra entrada e o `-1`
    // pararia em `/t/...`, com o player ainda na tela.
    const from = (state as { from?: unknown } | null)?.from;
    navigate(typeof from === 'string' ? from : PATHS.home, { replace: true });
  }, [navigate, state]);

  return useMemo(
    () => ({ isPlayerOpen, openPlayer, closePlayer }),
    [isPlayerOpen, openPlayer, closePlayer],
  );
}
