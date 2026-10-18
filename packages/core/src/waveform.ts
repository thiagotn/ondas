/**
 * Forma de onda da faixa.
 *
 * Os valores vêm do áudio de verdade: o worker mede o RMS de cada trecho na
 * ingestão e guarda o resultado junto da faixa. Faixa sem picos medidos —
 * todo o catálogo público, que o app nunca baixou inteiro — desenha barra
 * lisa, e é isso que o relevo passa a significar: o Ondas conhece este áudio.
 */

/** Quantos trechos o worker mede por faixa. Resolução de origem, não de tela. */
export const PICOS_POR_FAIXA = 200;

/**
 * Um caractere por pico, 6 bits cada (0..63).
 *
 * O mesmo alfabeto está em `api/internal/ingest/picos.go` — se um dos dois
 * mudar, a forma de onda sai embaralhada e nada quebra em voz alta. Base64 de
 * verdade empacotaria 3 valores em 4 caracteres; aqui um valor é um caractere,
 * o que custa 25% a mais (200 bytes por faixa) e dispensa bits atravessados
 * nos dois lados.
 */
const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const NIVEIS = ALFABETO.length;

/** Picos 0..1 → string. Usado nos testes e por quem medir áudio no cliente. */
export function codificarPicos(valores: readonly number[]): string {
  let s = '';
  for (const v of valores) {
    const n = Math.round(Math.min(1, Math.max(0, v)) * (NIVEIS - 1));
    s += ALFABETO[n];
  }
  return s;
}

/**
 * String → picos 0..1, ou `null` quando não há o que desenhar.
 *
 * Um caractere fora do alfabeto zera só ele: o resto da faixa continua
 * desenhável, e uma barra com um vão é melhor que nenhuma barra.
 */
export function decodificarPicos(s: string | null | undefined): number[] | null {
  if (!s) return null;
  const out: number[] = [];
  for (const c of s) {
    const i = ALFABETO.indexOf(c);
    out.push(i < 0 ? 0 : i / (NIVEIS - 1));
  }
  return out.length ? out : null;
}

/**
 * Reamostra os picos para a quantidade de barras que cabe na tela.
 *
 * Reduzindo, cada barra fica com o MÁXIMO do trecho que ela cobre, não com a
 * média: a média de um trecho que tem um transiente e silêncio dá meio-tom, e
 * a forma vira um borrão. Ampliando (menos picos que barras) a origem é
 * repetida — não há detalhe para inventar.
 */
export function reamostrarPicos(picos: readonly number[], barras: number): number[] {
  if (barras <= 0 || picos.length === 0) return [];
  const out: number[] = [];
  for (let i = 0; i < barras; i++) {
    const ini = Math.floor((i * picos.length) / barras);
    const fim = Math.max(ini + 1, Math.floor(((i + 1) * picos.length) / barras));
    let max = 0;
    for (let j = ini; j < fim && j < picos.length; j++) max = Math.max(max, picos[j]!);
    out.push(max);
  }
  return out;
}

/** Barras lisas, para faixa cujos picos ninguém mediu. */
export function picosLisos(barras: number): number[] {
  return Array.from({ length: Math.max(0, barras) }, () => NIVEL_LISO);
}

/** Altura da barra lisa, em fração da caixa. Baixa o bastante para não imitar som. */
export const NIVEL_LISO = 0.34;

/** Passo entre barras, em unidades do viewBox: 2px de barra + 1px de vão. */
export const PASSO = 3;

/** Altura da parte de cima do desenho, em unidades do viewBox. */
export const ALTURA = 100;
/** Vão entre o desenho e o reflexo. */
export const VAO_ECO = 7;
/** Altura do reflexo. */
export const ALTURA_ECO = 30;

/**
 * Quantas barras desenhar numa caixa de `larguraPx`.
 *
 * O teto é a resolução que o worker mede: pedir mais que isso só repetiria
 * pico, engrossando o desenho sem acrescentar informação.
 */
export function barCount(larguraPx: number): number {
  const n = Math.floor(larguraPx / PASSO);
  return Math.min(PICOS_POR_FAIXA, Math.max(12, n));
}

/** Largura do viewBox para uma quantidade de barras. */
export function waveWidth(barras: number): number {
  return Math.max(1, barras * PASSO);
}

/** Altura do viewBox, com ou sem reflexo. */
export function waveHeight(comEco: boolean): number {
  return comEco ? ALTURA + VAO_ECO + ALTURA_ECO : ALTURA;
}

export interface WavePaths {
  /** `d` da parte já tocada. */
  tocado: string;
  /** `d` do que já está em buffer mas ainda não tocou. */
  buffer: string;
  /** `d` do resto. */
  resto: string;
  /** Os mesmos três refletidos; vazios quando o reflexo está desligado. */
  ecoTocado: string;
  ecoBuffer: string;
  ecoResto: string;
  /** Posição do cursor no viewBox. */
  cursorX: number;
  largura: number;
  altura: number;
}

/** Piso de altura: um trecho em silêncio deixa fio, senão a barra parece furada. */
const PISO = 1.5;

type Faixa = 0 | 1 | 2;

function faixaDe(fracao: number, tocado: number, buf: number): Faixa {
  if (fracao <= tocado) return 0;
  if (fracao <= buf) return 1;
  return 2;
}

/**
 * Os seis caminhos do desenho — um `<path>` por faixa de cor, em vez de um
 * elemento por barra.
 *
 * Cada barra é um traço vertical (`M x,base V topo`) com `stroke-linecap:
 * butt`, então duzentas barras custam seis nós no DOM. A versão em caracteres
 * que isto substituiu criava um `<span>` por barra e remontava todos a cada
 * segundo de playback.
 */
export function wavePaths(
  picos: readonly number[],
  tocado: number,
  buf: number,
  comEco: boolean,
): WavePaths {
  const n = picos.length;
  const largura = waveWidth(n);
  const altura = waveHeight(comEco);
  const d: string[] = ['', '', ''];
  const eco: string[] = ['', '', ''];
  const baseEco = ALTURA + VAO_ECO;

  for (let i = 0; i < n; i++) {
    const faixa = faixaDe((i + 0.5) / n, tocado, buf);
    const x = (i * PASSO + PASSO / 2).toFixed(1);
    const v = Math.min(1, Math.max(0, picos[i]!));
    const h = Math.max(PISO, v * ALTURA);
    d[faixa] += `M${x},${ALTURA}V${(ALTURA - h).toFixed(1)}`;
    if (comEco) {
      const he = Math.max(PISO, v * ALTURA_ECO);
      eco[faixa] += `M${x},${baseEco}V${(baseEco + he).toFixed(1)}`;
    }
  }

  return {
    tocado: d[0]!,
    buffer: d[1]!,
    resto: d[2]!,
    ecoTocado: eco[0]!,
    ecoBuffer: eco[1]!,
    ecoResto: eco[2]!,
    cursorX: Math.min(1, Math.max(0, tocado)) * largura,
    largura,
    altura,
  };
}

/** Barra de buffer do full player: 24 caracteres `█` tocado / `▓` em buffer / `░` resto. */
export const BUFFER_BAR_LEN = 24;

export function bufferBar(played: number, buf: number): { a: string; b: string; c: string } {
  const a = Math.round(Math.min(1, Math.max(0, played)) * BUFFER_BAR_LEN);
  const b = Math.max(0, Math.round(Math.min(1, Math.max(0, buf)) * BUFFER_BAR_LEN) - a);
  return {
    a: '█'.repeat(a),
    b: '▓'.repeat(b),
    c: '░'.repeat(Math.max(0, BUFFER_BAR_LEN - a - b)),
  };
}
