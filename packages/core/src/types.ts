/** Tipos de domínio do Ondas. Puros: nada aqui depende de DOM ou de plataforma. */

export interface Track {
  id: string;
  title: string;
  artist: string;
  /** Slug sem acento, ex. "techno". */
  genre: string;
  /** Duração em segundos. */
  dur: number;
  /** URL da capa (480x480 quando disponível). Vazio = sem capa. */
  art: string;
  /** URL de stream. Vazio = faixa sem áudio (catálogo demo → playback simulado). */
  stream: string;
  /**
   * Faixa [pro]. Vem da API quando o backend informa; quando `undefined`,
   * as regras de acesso caem no heurístico do protótipo (ver `access.ts`).
   */
  premium?: boolean;
}

export interface User {
  name: string;
}

export type Session = User | null;

export type ThemeId =
  | 'nocturne'
  | 'catppuccin-mocha'
  | 'tokyonight'
  | 'dracula'
  | 'gruvbox-dark'
  | 'nord'
  | 'rose-pine'
  | 'solarized-dark'
  | 'github-light';

export interface ThemeDef {
  id: ThemeId;
  name: string;
  bg: string;
  fg: string;
  accent: string;
  /** ansi-0 … ansi-7 */
  ansi: readonly [string, string, string, string, string, string, string, string];
}

export type TabId = 'home' | 'search' | 'library';
export type LibrarySegment = 'liked' | 'offline';
export type GateKind = 'play' | 'dl';

export interface Gate {
  kind: GateKind;
  title: string;
}

/** Rótulo da origem dos metadados, exibido no comentário do prompt. */
export type CatalogSource =
  | 'audius api (ao vivo)'
  | 'metadados em cache local'
  | 'catálogo demo — api inacessível'
  | 'catálogo demo';

export interface Catalog {
  tracks: Track[];
  source: CatalogSource;
}

/** Barra da waveform: caractere de bloco + a cor (CSS var) que lhe cabe. */
export interface WaveBar {
  ch: string;
  color: string;
}
