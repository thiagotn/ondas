import type { Track } from '@ondas/core';
import { useQuery } from '@tanstack/react-query';
import { catalogClient } from '../app/services';

/**
 * Uma faixa pelo id, para o deeplink de uma música que não está no catálogo
 * carregado.
 *
 * Chave fora da do catálogo (`catalogKey`) de propósito: esta não é escopada
 * por sessão porque só id PÚBLICO chega aqui — faixa do acervo nunca é
 * resolvida por esta via (ver `TrackRoute`).
 */
export function useTrackById(id: string | null) {
  return useQuery<Track | null>({
    queryKey: ['track', id],
    enabled: !!id,
    queryFn: ({ signal }) => catalogClient.track!(id!, { signal }),
  });
}
