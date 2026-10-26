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
  /**
   * Capa pequena (150x150) para a lista: 5KB contra 35KB da grande, num thumb
   * de 36px. `undefined` em catálogos que não oferecem variação de tamanho.
   */
  artThumb?: string;
  /** URL de stream. Vazio = faixa sem áudio (catálogo demo → playback simulado). */
  stream: string;
  /**
   * Faixa [pro]. Vem da API quando o backend informa; quando `undefined`,
   * as regras de acesso caem no heurístico do protótipo (ver `access.ts`).
   */
  premium?: boolean;
  /**
   * De onde a faixa veio. `acervo` são as faixas próprias, que só existem para
   * quem está logado — a lista marca essas e o resto segue igual. `undefined`
   * é o catálogo público (nenhum código antigo precisou mudar por causa disto).
   */
  source?: 'audius' | 'acervo';
  /**
   * Forma de onda medida no áudio, um caractere por trecho (ver
   * `waveform.ts`). Só as faixas do acervo têm: do catálogo público o app
   * nunca baixa o arquivo inteiro, então não há o que medir. Ausente = barra
   * lisa.
   */
  peaks?: string;
}

export interface User {
  name: string;
}

export type Session = User | null;

/** Origem da imagem de fundo: capa da faixa, imagem enviada ou nenhuma. */
export type WallMode = 'capa' | 'imagem' | 'nenhum';

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
export type LibrarySegment = 'liked' | 'offline' | 'acervo';
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
  /**
   * Quantas faixas do acervo entraram na lista. Fica fora de `source` de
   * propósito: `CatalogSource` descreve de onde vieram os metadados PÚBLICOS e
   * continua sendo um conjunto fechado de rótulos — compor string ali faria o
   * tipo deixar de dizer qualquer coisa.
   */
  acervo?: number;
}

