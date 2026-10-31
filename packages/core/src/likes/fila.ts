/**
 * A fila de curtidas que ainda não subiram.
 *
 * Existe porque a PWA é instalada e toca sem rede: curtir offline tem de valer
 * na tela na hora e subir depois. Sem fila haveria perda silenciosa — o boot
 * seguinte traz a lista do servidor e a curtida feita no avião sumiria sem
 * ninguém ver.
 */
export interface FilaDeCurtidas {
  add: string[];
  remove: string[];
}

export const FILA_VAZIA: FilaDeCurtidas = { add: [], remove: [] };

/**
 * Põe uma mudança na fila, mantendo as duas listas DISJUNTAS.
 *
 * Esse é o invariante que importa, e ele é a razão de esta função existir em
 * vez de dois `push`: curtir tira o id de `remove`, descurtir tira de `add`.
 * Com isso o servidor nunca precisa decidir uma ordem entre apagar e inserir,
 * e curtir–descurtir–curtir sem rede vira UM `add`, não três operações que se
 * desfazem no caminho.
 *
 * O estado final é o que manda: a fila descreve onde a pessoa quer chegar, não
 * o caminho que ela fez.
 */
export function enfileirar(f: FilaDeCurtidas, id: string, curtir: boolean): FilaDeCurtidas {
  const add = f.add.filter((x) => x !== id);
  const remove = f.remove.filter((x) => x !== id);
  if (curtir) add.push(id);
  else remove.push(id);
  return { add, remove };
}

export function filaVazia(f: FilaDeCurtidas): boolean {
  return f.add.length === 0 && f.remove.length === 0;
}

/**
 * A coleção do servidor com a fila que ainda não subiu aplicada por cima.
 *
 * Existe por causa da corrida: entre mandar a fila e a resposta chegar, a
 * pessoa pode ter tocado em mais um coração. A resposta do servidor não sabe
 * dessa última mudança, e aplicá-la crua faria o coração voltar atrás sozinho
 * na tela — o tipo de bug que parece "o app desfez o que eu fiz".
 */
export function aplicarFila(ids: readonly string[], f: FilaDeCurtidas): string[] {
  const fora = new Set(f.remove);
  const final = ids.filter((id) => !fora.has(id));
  const tem = new Set(final);
  for (const id of f.add) {
    if (!tem.has(id)) final.push(id);
  }
  return final;
}

/**
 * O que sobrou da fila depois de uma subida bem-sucedida.
 *
 * NÃO é "zera a fila": o que entrou nela durante o voo precisa sobreviver,
 * senão uma curtida feita enquanto a anterior subia some sem deixar rastro.
 * Só sai o que de fato foi mandado — e um id que mudou de lado no meio do
 * caminho fica, porque ele está na lista contrária.
 */
export function semOQueSubiu(atual: FilaDeCurtidas, enviada: FilaDeCurtidas): FilaDeCurtidas {
  const subiuAdd = new Set(enviada.add);
  const subiuRemove = new Set(enviada.remove);
  return {
    add: atual.add.filter((id) => !subiuAdd.has(id)),
    remove: atual.remove.filter((id) => !subiuRemove.has(id)),
  };
}

/**
 * Lê uma fila que veio do disco.
 *
 * O que está no IndexedDB foi gravado por uma versão anterior deste código e
 * atravessou um `JSON` — tratar como `FilaDeCurtidas` sem conferir é o jeito
 * de um campo estranho virar `undefined.length` no boot. Lixo vira fila vazia,
 * que é o pior caso aceitável: perde-se o que não subiu, e não o app inteiro.
 */
export function leFila(bruto: unknown): FilaDeCurtidas {
  if (!bruto || typeof bruto !== 'object') return FILA_VAZIA;
  const f = bruto as Partial<FilaDeCurtidas>;
  const lista = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [];
  return { add: lista(f.add), remove: lista(f.remove) };
}
