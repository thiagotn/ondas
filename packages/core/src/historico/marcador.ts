/**
 * O marcador: onde a conta parou, e quando vale gravar isso.
 *
 * NÃO confundir com `retomada.ts`. Aquele decide se o player insiste sozinho
 * numa faixa que falhou há menos de cinco minutos, em memória. Este guarda a
 * posição na CONTA, para a pessoa continuar em outro aparelho — e nunca faz
 * som sozinho.
 *
 * Tudo aqui é aritmética sobre amostras do player, sem relógio e sem rede
 * próprios: quem chama passa o `agora`. É o que deixa testar "quinze segundos
 * depois" sem esperar quinze segundos.
 */
import type { Marcador } from '../ports/historico.js';

/** De quanto em quanto tempo de música o espelho local é regravado. */
export const ESPELHAR_A_CADA_MS = 5_000;

/** De quanto em quanto tempo de música o marcador sobe para a conta. */
export const SUBIR_A_CADA_MS = 15_000;

/**
 * O maior salto de `t` entre duas amostras que ainda é música tocando.
 *
 * O `timeupdate` vem a cada ~250 ms; uma aba em segundo plano o espaça para
 * ~1 s. Acima de dois segundos, ou para trás, não foi o tempo que passou: foi
 * alguém que arrastou a barra.
 */
const SALTO_MAXIMO_S = 2;

/** Quanto de escuta faz uma faixa contar como ouvida. */
export const LIMIAR_DE_ESCUTA_S = 30;

/** O que o observador precisa ver do player a cada mudança. */
export interface Amostra {
  curId: string | null;
  t: number;
  dur: number;
  playing: boolean;
  waiting: boolean;
  /** `Date.now()`. */
  agora: number;
}

export interface EstadoDoObservador {
  curId: string | null;
  t: number;
  playing: boolean;
  /**
   * Som saiu desta faixa desde que ela foi carregada.
   *
   * É a trava do "aparelho parado não escreve": faixa armada na restauração,
   * faixa cujo `load` nunca começou e faixa só arrastada na barra não têm
   * `tocou`, e sem ele nada sobe. Um aparelho aberto na mesa não pode gravar
   * por cima do que outro acabou de ouvir.
   */
  tocou: boolean;
  /** Segundos de fato OUVIDOS desta faixa — arrastar a barra não soma. */
  ouvido: number;
  /** A faixa já entrou no histórico nesta carga. */
  contou: boolean;
  /** Há posição nova que o espelho ainda não tem. */
  sujo: boolean;
  espelhadoEm: number;
  subidoEm: number;
}

/**
 * - `espelhar`: gravar a posição no aparelho;
 * - `subir`: mandar a posição para a conta;
 * - `contar`: a faixa acabou de passar do limiar e entra no histórico.
 */
export type Efeito = 'espelhar' | 'subir' | 'contar';

export const OBSERVADOR_VAZIO: EstadoDoObservador = {
  curId: null,
  t: 0,
  playing: false,
  tocou: false,
  ouvido: 0,
  contou: false,
  sujo: false,
  espelhadoEm: 0,
  subidoEm: 0,
};

/**
 * Quanto de escuta esta faixa precisa para contar: trinta segundos, ou metade
 * dela se for mais curta que um minuto. Uma vinheta de vinte segundos conta
 * aos dez; sem a metade ela nunca entraria no histórico.
 */
export function limiarDeEscuta(dur: number): number {
  return dur > 0 ? Math.min(LIMIAR_DE_ESCUTA_S, dur / 2) : LIMIAR_DE_ESCUTA_S;
}

/**
 * Vê uma amostra do player e diz o que fazer com ela.
 *
 * As regras, na ordem em que o código as aplica:
 *
 * 1. **Faixa nova zera a conta** e não produz efeito nenhum. Carregar não é
 *    ouvir: quem escreve é o primeiro progresso real, logo abaixo.
 * 2. **Progresso real** (`playing`, sem `waiting`, `t` andando para a frente em
 *    passo de música) soma em `ouvido`, suja o espelho e:
 *    - no PRIMEIRO progresso da faixa, sobe na hora — é o momento em que "estou
 *      ouvindo isto" passa a ser verdade, e esperar quinze segundos deixaria o
 *      outro aparelho com a faixa anterior;
 *    - depois, espelha e sobe nos intervalos de cada um;
 *    - ao cruzar o limiar, conta uma vez.
 * 3. **Salto** (barra arrastada) numa faixa que já tocou sobe na hora, e NÃO
 *    soma em `ouvido`. Numa faixa que ainda não tocou — o player armado — não
 *    sobe: a posição nova vale quando o play vier.
 * 4. **Pausa** numa faixa que tocou espelha e sobe: é o último instante em que
 *    se sabe onde a pessoa parou.
 */
export function observar(
  estado: EstadoDoObservador,
  a: Amostra,
): { estado: EstadoDoObservador; efeitos: Efeito[] } {
  if (a.curId !== estado.curId) {
    return {
      estado: {
        ...OBSERVADOR_VAZIO,
        curId: a.curId,
        t: a.t,
        playing: a.playing,
        espelhadoEm: estado.espelhadoEm,
        subidoEm: estado.subidoEm,
      },
      efeitos: [],
    };
  }
  if (a.curId === null) return { estado, efeitos: [] };

  const efeitos = new Set<Efeito>();
  const novo: EstadoDoObservador = { ...estado, t: a.t, playing: a.playing };
  const delta = a.t - estado.t;

  if (a.playing && !a.waiting && delta > 0 && delta <= SALTO_MAXIMO_S) {
    novo.ouvido = estado.ouvido + delta;
    novo.sujo = true;
    if (!estado.tocou) {
      novo.tocou = true;
      efeitos.add('espelhar').add('subir');
    } else {
      if (a.agora - estado.espelhadoEm >= ESPELHAR_A_CADA_MS) efeitos.add('espelhar');
      if (a.agora - estado.subidoEm >= SUBIR_A_CADA_MS) efeitos.add('subir');
    }
    if (!estado.contou && novo.ouvido >= limiarDeEscuta(a.dur)) {
      novo.contou = true;
      efeitos.add('contar');
    }
  } else if (delta !== 0 && estado.tocou) {
    // Salto: para trás, ou longe demais para ser o tempo passando.
    novo.sujo = true;
    efeitos.add('espelhar').add('subir');
  }

  if (estado.playing && !a.playing && estado.tocou) {
    efeitos.add('espelhar').add('subir');
  }

  if (efeitos.has('subir')) {
    // Quem sobe também espelha: o espelho nunca fica atrás do servidor.
    efeitos.add('espelhar');
    novo.subidoEm = a.agora;
  }
  if (efeitos.has('espelhar')) {
    novo.espelhadoEm = a.agora;
    novo.sujo = false;
  }
  return { estado: novo, efeitos: [...efeitos] };
}

/** A posição que vira marcador, a partir da amostra. `null` sem faixa. */
export function marcadorDaAmostra(a: Amostra): Marcador | null {
  if (a.curId === null) return null;
  return { trackId: a.curId, pos: Math.max(0, a.t), dur: Math.max(0, a.dur), em: a.agora };
}

/**
 * De onde retomar, dado o que foi gravado.
 *
 * As duas pontas voltam a zero. Nos primeiros segundos, retomar "do segundo 3"
 * é só perder a entrada da música. E no fim — a faixa acabou, ou a fila acabou
 * com ela — armar o player a dois segundos do final faria o play tocar um
 * rabicho e pular: quem volta quer a faixa, não o silêncio depois dela.
 */
export function posicaoDeRetomada(pos: number, dur: number): number {
  if (!(pos >= 5)) return 0;
  if (dur > 0 && pos > dur - 10) return 0;
  return pos;
}

/** `a` foi gravado depois de `b`? Empate não é "mais novo". */
export function maisNovo(a: Marcador, b: Marcador): boolean {
  return a.em > b.em;
}

/**
 * Lê um marcador que veio de fora — do disco ou da rede.
 *
 * Atravessou um `JSON` e pode ter sido escrito por outra versão deste código.
 * Lixo vira `null`, que é "sem marcador": o pior caso é não retomar, e não um
 * `NaN` posto no `currentTime` do áudio.
 */
export function leMarcador(bruto: unknown): Marcador | null {
  if (!bruto || typeof bruto !== 'object') return null;
  const m = bruto as Partial<Record<keyof Marcador, unknown>>;
  const numero = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (typeof m.trackId !== 'string' || !m.trackId) return null;
  if (!numero(m.pos) || !numero(m.em) || m.em <= 0) return null;
  return { trackId: m.trackId, pos: m.pos, dur: numero(m.dur) ? m.dur : 0, em: m.em };
}

/** O marcador como fica no aparelho. */
export interface EspelhoDoMarcador {
  marcador: Marcador;
  /** Ainda não subiu para a conta — sobe quando a rede voltar. */
  pendente: boolean;
}

export function leEspelho(bruto: unknown): EspelhoDoMarcador | null {
  if (!bruto || typeof bruto !== 'object') return null;
  const e = bruto as { marcador?: unknown; pendente?: unknown };
  const marcador = leMarcador(e.marcador);
  return marcador ? { marcador, pendente: e.pendente === true } : null;
}

/**
 * O que fazer com o marcador quando a lista de faixas chega.
 *
 * - `armar`: a faixa está na lista — põe no player, pausada;
 * - `esperar`: não está, mas a lista ainda é a do cache e a de verdade está a
 *   caminho — decidir agora seria decidir com dado velho;
 * - `buscar`: não está, mas é de catálogo público — vale pedir por id;
 * - `nada`: não há o que restaurar, ou não cabe restaurar agora.
 *
 * `esperar` existe por causa do caso que é a razão de ser disto tudo: a faixa
 * enviada ao acervo no desktop e ouvida lá não está no catálogo que o celular
 * guardou ontem. Sem esperar o refetch, o celular concluiria "faixa do acervo
 * fora da lista" e desistiria da retomada um segundo antes de a faixa chegar.
 *
 * Os três "nada" que não são óbvios:
 *
 * - **link de faixa na URL**: quem abriu `/t/...` pediu AQUELA faixa, e o
 *   marcador não disputa com um pedido explícito;
 * - **player já ocupado**: a pessoa deu play antes de a restauração chegar. O
 *   que ela escolheu agora vale mais do que onde ela parou ontem;
 * - **faixa do acervo fora da lista**: o catálogo do logado traz o acervo
 *   INTEIRO, então a ausência é resposta — foi apagada, ou deixou de ser
 *   compartilhada. Não há por id o que buscar, e avisar seria anunciar a
 *   existência de uma faixa que a pessoa não pode mais ouvir.
 */
export function decidirRestauracao(args: {
  marcador: Marcador | null;
  curId: string | null;
  deeplink: boolean;
  ids: ReadonlySet<string>;
  /** A lista é provisória: veio do cache e há um refetch em andamento. */
  atualizando?: boolean;
}): 'armar' | 'esperar' | 'buscar' | 'nada' {
  const { marcador, curId, deeplink, ids } = args;
  if (!marcador || deeplink || curId !== null) return 'nada';
  if (ids.has(marcador.trackId)) return 'armar';
  if (args.atualizando) return 'esperar';
  if (marcador.trackId.startsWith(PREFIXO_ACERVO)) return 'nada';
  return 'buscar';
}

/** O prefixo que a API põe no id de faixa do acervo (`prefixoID` em `acervo.go`). */
const PREFIXO_ACERVO = 'acervo:';
