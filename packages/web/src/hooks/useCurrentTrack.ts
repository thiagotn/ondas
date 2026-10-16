import type { Track } from '@ondas/core';
import { usePlayer } from '../app/stores';
import { useCatalog } from '../query/catalog';

/**
 * A faixa atual, reativa: o índice vem da store do player e as faixas da query
 * do catálogo. (`controller.currentTrack()` serve para quem está fora do React.)
 */
export function useCurrentTrack(): Track | undefined {
  const cur = usePlayer((s) => s.cur);
  const { data } = useCatalog();
  return cur >= 0 ? data?.tracks[cur] : undefined;
}
