import { MAX_AVULSAS, type Track } from '@ondas/core';
import { create } from 'zustand';

interface Avulsas {
  /** Faixas abertas por deeplink que não estavam no catálogo carregado. */
  list: Track[];
  add(track: Track): void;
}

/**
 * Faixas abertas por link.
 *
 * Fica FORA do react-query de propósito. A alternativa curta seria
 * `queryClient.setQueryData(catalogKey(...), …)`, mas o próximo refetch do
 * trending sobrescreveria `tracks`: no meio da escuta a faixa sumiria da
 * lista, `setTracks` reancoraria para `cur: -1` e a barra de baixo
 * desapareceria com o áudio ainda tocando. Também não é persistido — link
 * aberto não é biblioteca.
 */
export const useAvulsas = create<Avulsas>((set) => ({
  list: [],
  add: (track) =>
    set((st) =>
      st.list.some((t) => t.id === track.id)
        ? st
        : { list: [...st.list, track].slice(-MAX_AVULSAS) },
    ),
}));
