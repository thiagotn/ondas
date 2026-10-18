import type { Track } from '../types.js';

export interface TrendingOptions {
  limit?: number;
  signal?: AbortSignal;
}

/**
 * Fonte de metadados do catálogo. O adapter Audius existe hoje; um backend
 * próprio é só outra implementação desta interface.
 */
export interface CatalogClient {
  trending(options?: TrendingOptions): Promise<Track[]>;
  /**
   * Metadados de UMA faixa, para abrir um deeplink de música que não está na
   * lista carregada. `null` = não existe ou não é tocável.
   */
  track?(id: string, options?: TrendingOptions): Promise<Track | null>;
  /** URL de stream da faixa, quando a fonte precisa montá-la na hora. */
  streamUrl?(trackId: string): string | null;
}
