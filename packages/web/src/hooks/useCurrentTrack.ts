import type { Track } from '@ondas/core';
import { usePlayer } from '../app/stores';
import { useCatalog } from '../query/catalog';

/**
 * A faixa atual, reativa.
 *
 * Procura pelo `curId`, não pelo índice: a lista muda de tamanho quando o
 * acervo entra ou sai, e o índice de ontem aponta para a faixa errada hoje.
 * (`controller.currentTrack()` serve para quem está fora do React.)
 */
export function useCurrentTrack(): Track | undefined {
  const curId = usePlayer((s) => s.curId);
  const { data } = useCatalog();
  if (!curId) return undefined;
  return data?.tracks.find((t) => t.id === curId);
}
