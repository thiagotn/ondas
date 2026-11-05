/**
 * Quando vale retomar sozinho o que parou.
 *
 * O player guarda uma **pendência** quando o som não começou: a faixa que ele
 * queria estar tocando, e desde quando espera. Alguma coisa de fora — a rede
 * voltando, a tela acendendo — avisa que é hora de tentar de novo.
 *
 * A regra mora aqui, e não no controller, porque ela é só aritmética sobre
 * três fatos e é o tipo de condição que se erra em silêncio: retomar o que não
 * devia faz a música explodir sozinha no bolso de alguém.
 */

/**
 * Depois disto, a pendência não é mais o que a pessoa queria.
 *
 * O gatilho de visibilidade dispara dezenas de vezes por dia. Sem um prazo,
 * pegar o telefone de noite poderia fazer voltar a faixa que parou de manhã.
 * Cinco minutos cobrem o caso real — o telefone no bolso, a tela acendendo
 * logo depois — e não cobrem o esquecimento.
 */
export const JANELA_DE_RETOMADA_MS = 5 * 60_000;

/** A faixa que o player queria estar tocando, e desde quando espera. */
export interface Pendencia {
  /** `avancar` = ir para a próxima; `retomar` = insistir nesta mesma. */
  tipo: 'avancar' | 'retomar';
  index: number;
  /** `Date.now()` de quando o player desistiu. */
  em: number;
}

/**
 * Vale retomar?
 *
 * `tocando` é a defesa contra o caso que só aparece com o gatilho de
 * visibilidade: a música já voltou sozinha, a pessoa acende a tela, e retomar
 * reiniciaria do `0:00` a faixa que estava no meio.
 *
 * E `tocando` quer dizer **som saindo**, não "foi pedido para tocar": um
 * elemento de áudio cuja fonte morreu fica com `paused === false` sem emitir
 * ruído nenhum, e tomá-lo por tocando faria a retomada nunca acontecer
 * justamente quando ela é necessária.
 */
export function valeRetomar(
  pendencia: Pendencia | null,
  agora: number,
  tocando: boolean,
): pendencia is Pendencia {
  if (!pendencia) return false;
  if (tocando) return false;
  return agora - pendencia.em <= JANELA_DE_RETOMADA_MS;
}
