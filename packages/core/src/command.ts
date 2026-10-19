/**
 * A linha de comando do prompt — `:08` leva à faixa 08.
 *
 * O número é a POSIÇÃO que a lista mostra na calha da esquerda: 1-based e
 * global, isto é, contada na lista completa do catálogo e não no recorte da
 * aba (ver `useTrackRows`). Por isso `:08` significa a mesma faixa em qualquer
 * aba, mesmo onde os números na tela aparecem esparsos (`03`, `17`, `42`).
 */

import type { Track } from './types.js';

export type Comando = { kind: 'faixa'; numero: number };

/**
 * Lê o que foi digitado no prompt.
 *
 * O `:` é opcional porque o prompt já desenha o `:` fora do campo — quem
 * digita vê `:08` e tem `08` no input. Aceita até 3 dígitos: a calha é
 * `width: 3ch`, então é o maior número que a lista consegue exibir.
 *
 * `0` não existe (a numeração começa em 1) e volta `null`, igual a lixo.
 */
export function parseComando(texto: string): Comando | null {
  const limpo = texto.trim().replace(/^:/, '');
  if (!/^\d{1,3}$/.test(limpo)) return null;
  const numero = Number(limpo);
  return numero >= 1 ? { kind: 'faixa', numero } : null;
}

/**
 * A faixa de número `numero`, ou `undefined` fora de alcance.
 *
 * Existe para o -1 ter um só lugar no código: a lista é 0-based, a calha é
 * 1-based, e errar isso em silêncio toca a faixa vizinha.
 */
export function faixaPorNumero(tracks: readonly Track[], numero: number): Track | undefined {
  return tracks[numero - 1];
}
