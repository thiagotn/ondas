/**
 * Move um id uma casa para baixo (`1`) ou para cima (`-1`).
 *
 * NÃO dá a volta nas bordas, como o `moverCursor` da lista: `K` na primeira
 * faixa a deixa onde está. Dar a volta aqui seria pior que inofensivo —
 * apertar uma vez a mais mandaria a faixa do topo para o fim da playlist, e
 * desfazer isso é refazer a ordem à mão.
 *
 * Devolve a MESMA referência quando nada muda (id ausente, ou borda), e é isso
 * que deixa quem chama não gastar um PATCH para não fazer nada.
 */
export function moverNaOrdem(
  ids: readonly string[],
  id: string,
  dir: 1 | -1,
): readonly string[] {
  const de = ids.indexOf(id);
  if (de < 0) return ids;
  const para = de + dir;
  if (para < 0 || para >= ids.length) return ids;
  const nova = [...ids];
  nova[de] = nova[para]!;
  nova[para] = id;
  return nova;
}
