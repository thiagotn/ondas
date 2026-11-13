/** Tipos de domínio do Ondas. Puros: nada aqui depende de DOM ou de plataforma. */

import type { PrefsDaConta } from './prefs.js';

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
   * Nome de quem é a faixa, PRESENTE SÓ QUANDO ELA NÃO É SUA.
   *
   * É a ausência dele que separa os dois recortes do acervo: `--acervo` são as
   * faixas sem dono anotado (as minhas) e `--compartilhadas` são as com
   * (as de outra pessoa que posso ouvir, ver `visibleTracks`). Por isso é
   * `undefined` na faixa própria em vez de vir sempre preenchido — a API decide
   * isso em `paraJSONVisivel` e a tela só obedece.
   *
   * É nome de exibição, nunca e-mail: a linha precisa de um rótulo, e o e-mail
   * de uma pessoa não é da outra.
   */
  owner?: string;
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
  /**
   * O catálogo público entra na lista desta conta ou não. Vem do servidor em
   * toda resposta de auth (`publico` na API), e mora na conta porque é escolha
   * sobre o que se quer ouvir — segue para qualquer aparelho, ao contrário do
   * `buffer`, que é deste navegador.
   *
   * OPCIONAL, e `undefined` vale `true`. Não é frouxidão: `restore()` devolve o
   * espelho local sem validar quando não há rede (`auth/http.ts`), e um espelho
   * gravado antes desta versão não tem o campo. Se `undefined` valesse
   * "desligado", o catálogo público desapareceria sozinho para quem nunca pediu
   * isso — offline, onde não há como corrigir. A leitura é uma só e mora em
   * `showsPublicCatalog` (`view.ts`), escrita como `!== false`.
   */
  publico?: boolean;
  /**
   * A aparência que segue a conta — tema, idioma e ajustes do fundo.
   *
   * OPCIONAL, e `undefined` NÃO é o mesmo que `{}`. `{}` é o servidor dizendo
   * "esta conta nunca escolheu"; `undefined` é não haver servidor que saiba do
   * assunto — uma API de antes das preferências, ou um espelho gravado por
   * uma versão antiga. No segundo caso o aparelho segue só local e não manda
   * nada (ver `decidirPrefs`).
   */
  prefs?: PrefsDaConta;
  /**
   * Esta conta pode enviar arquivo para o acervo (`podeEnviar` na API).
   *
   * Conta nova nasce sem isso: ela usa a plataforma inteira, menos o envio, até
   * o admin liberar. Serve só para a tela não oferecer um botão que o servidor
   * vai recusar — quem recusa de verdade é ele.
   *
   * OPCIONAL, e `undefined` vale `true`, pela mesma razão de `publico`: um
   * espelho local gravado antes deste campo é de uma conta que já existia, e
   * todas elas enviam. A leitura é uma só e mora em `canUpload` (`access.ts`).
   */
  podeEnviar?: boolean;
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
export type LibrarySegment = 'liked' | 'playlists' | 'history' | 'offline' | 'acervo' | 'shared';

/**
 * Uma playlist da conta: um nome e uma ORDEM de ids.
 *
 * Nenhum metadado de faixa mora aqui, pela mesma decisão das curtidas — a
 * playlist é um recorte do catálogo que está carregado, e não uma lista que se
 * basta. A consequência é visível na tela e está dita lá: faixa pública que sai
 * do trending sai da playlist, e `hiddenInSegment` conta quantas são para o
 * texto de vazio não mentir.
 *
 * `itens` é a ordem, e é por isso que é um array e não um `Record<string,
 * boolean>` como `liked`: ali a pergunta é "está?", aqui é "em que lugar?".
 */
export interface Playlist {
  id: string;
  nome: string;
  itens: string[];
}
export type GateKind = 'play' | 'dl';

export interface Gate {
  kind: GateKind;
  title: string;
}

/**
 * Origem dos metadados, mostrada depois de `fonte: ` no comentário do prompt.
 *
 * São CÓDIGOS, e não as frases que aparecem na tela. Eram as frases, e isso não
 * sobrevivia a mais de um idioma: `view.ts` compara a origem para decidir se
 * escreve o `+ acervo (N)`, e uma comparação contra texto traduzido passa a dar
 * falso sem avisar ninguém. O rótulo mora em `i18n`, e o que atravessa o código
 * é o código.
 *
 * `'acervo'` é o único membro que NÃO descreve procedência de metadado público:
 * ele diz que não houve busca pública nenhuma, porque a conta desligou o
 * catálogo (`showsPublicCatalog`). Cabe no tipo por ser a mesma coisa do ponto
 * de vista de quem lê a linha — a resposta a "de onde veio esta lista".
 */
export type CatalogSource = 'audius' | 'cache' | 'demo-offline' | 'demo' | 'acervo';

export interface Catalog {
  tracks: Track[];
  source: CatalogSource;
  /**
   * Quantas faixas do acervo entraram na lista — as minhas MAIS as que outra
   * pessoa compartilhou comigo, porque as duas vêm da mesma rota e as duas são
   * o que o catálogo público não é.
   *
   * Fica fora de `source` de propósito: `CatalogSource` descreve de onde vieram
   * os metadados PÚBLICOS e continua sendo um conjunto fechado de rótulos —
   * compor string ali faria o tipo deixar de dizer qualquer coisa.
   */
  acervo?: number;
}

/**
 * O que a API devolve quando recusa: a frase em pt-BR E um código estável.
 *
 * O código é o que atravessa a fronteira — a frase da API só sobrevive como
 * reserva, para um código que esta versão da PWA ainda não conheça. Ver
 * `api/internal/httpapi/erros.go`.
 */
export interface ErroDaApi {
  /** Código estável, sem idioma. Vazio em servidor anterior aos códigos. */
  codigo?: string;
  /** Números que a frase precisa (um teto, um mínimo). */
  params?: Record<string, unknown>;
}
