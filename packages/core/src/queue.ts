import { isLocked } from './access.js';
import type { AccessOptions } from './access.js';
import type { Session, Track } from './types.js';

export interface QueueContext {
  tracks: readonly Track[];
  session: Session;
  offline: boolean;
  cached: Readonly<Record<string, boolean>>;
  shuffle: boolean;
  repeat: boolean;
  /** Índice atual, ou -1 quando nada foi carregado. */
  cur: number;
  options?: AccessOptions;
  /**
   * A FILA: os ids das linhas que estão na tela, na ordem em que aparecem.
   *
   * `tracks` continua sendo o catálogo COMPLETO, e é ele que dá o índice — as
   * regras de acesso dependem da posição global (`isLocked`, e o heurístico
   * `index % 3` do protótipo por baixo dela). A fila só decide o CAMINHO: por
   * onde `n`, `p` e o fim da faixa andam.
   *
   * Sem ela, `n` anda pelo catálogo inteiro, que é o comportamento anterior às
   * playlists — e o que fazia o `n` em `--curtidas` pular para a faixa seguinte
   * do catálogo, saindo do recorte. Numa playlist isso seria fatal: na segunda
   * faixa a playlist já tinha acabado.
   *
   * Opcional porque "não sei o que está na tela" tem de ter resposta: no boot,
   * antes de qualquer lista montar, e em qualquer chamador que não passe a
   * fila, vale o catálogo inteiro.
   */
  fila?: readonly string[];
}

/**
 * O caminho que `n`/`p` percorrem, em ÍNDICES do catálogo completo.
 *
 * É aqui que a fila de ids vira posição: um id que não está no catálogo
 * carregado (faixa pública que saiu do trending e continua na playlist) some do
 * caminho, em vez de virar um passo que não toca nada.
 */
function caminho(ctx: QueueContext): number[] {
  if (!ctx.fila?.length) return ctx.tracks.map((_, i) => i);
  const porID = new Map(ctx.tracks.map((t, i) => [t.id, i]));
  const indices: number[] = [];
  for (const id of ctx.fila) {
    const i = porID.get(id);
    if (i !== undefined) indices.push(i);
  }
  // Fila que não casa com nada (a lista da tela é de outro catálogo, por um
  // quadro) não pode deixar `n` morto: cai no catálogo inteiro.
  return indices.length ? indices : ctx.tracks.map((_, i) => i);
}

/** Tocável: não bloqueada e, se estamos offline, presente no aparelho. */
export function isPlayable(ctx: QueueContext, index: number): boolean {
  const tr = ctx.tracks[index];
  if (!tr) return false;
  if (isLocked(tr, index, ctx.session, ctx.options)) return false;
  if (ctx.offline && !ctx.cached[tr.id]) return false;
  return true;
}

/** Primeira faixa tocável da fila (ou da lista, sem fila), ou -1 se nenhuma serve. */
export function firstPlayable(ctx: QueueContext): number {
  for (const i of caminho(ctx)) if (isPlayable(ctx, i)) return i;
  return -1;
}

/**
 * Próxima (`dir = 1`) ou anterior (`dir = -1`), pulando faixas não tocáveis.
 * Com shuffle, sorteia a cada tentativa. Retorna -1 quando não há destino.
 * `rnd` é injetável para os testes.
 *
 * Anda pela FILA e devolve ÍNDICE DO CATÁLOGO: quem chama (`controller.play`)
 * fala em índice global, e as regras de acesso também. O shuffle sorteia dentro
 * da fila — antes dela ele sorteava o catálogo inteiro, o que em `--curtidas`
 * era quase sempre uma faixa que não estava na tela.
 *
 * Faixa atual FORA da fila (tocando uma do acervo e indo para `--curtidas`, por
 * exemplo): `n` entra pela primeira linha da fila e `p` pela última. É o que a
 * aritmética abaixo já faz com `pos = -1`, e é a resposta certa — a alternativa
 * seria não andar.
 */
export function stepIndex(ctx: QueueContext, dir: 1 | -1, rnd: () => number = Math.random): number {
  const indices = caminho(ctx);
  const n = indices.length;
  if (!n) return -1;
  // Fora da fila (ou nada carregado): `n` entra pela PRIMEIRA linha dela e `p`
  // pela ÚLTIMA. É a regra legível, e ela precisa ser escrita: a aritmética
  // circular com `pos = -1` daria a primeira para `n` e a SEGUNDA para `p`,
  // que não é resposta nenhuma — é só o que o resto dividido calhou de dar.
  let pos = indices.indexOf(ctx.cur);
  if (pos < 0) pos = dir === 1 ? -1 : 0;
  for (let k = 0; k < n; k++) {
    pos = ctx.shuffle ? Math.floor(rnd() * n) : (pos + dir + n) % n;
    const i = indices[pos]!;
    if (isPlayable(ctx, i)) return i;
  }
  return -1;
}

export type EndedAction = { type: 'restart' } | { type: 'play'; index: number } | { type: 'stop' };

/** Fim da faixa: repeat-one reinicia, senão vai para a próxima tocável. */
export function onEnded(ctx: QueueContext, rnd: () => number = Math.random): EndedAction {
  if (ctx.repeat) return { type: 'restart' };
  const next = stepIndex(ctx, 1, rnd);
  return next < 0 ? { type: 'stop' } : { type: 'play', index: next };
}

/**
 * Próxima faixa desbloqueada a pré-carregar (smart buffer). -1 quando não há.
 *
 * Pela mesma fila do `stepIndex`, e isto não é só simetria: o buffer existe para
 * a faixa que VAI tocar estar no aparelho antes da hora. Pré-carregar a vizinha
 * no catálogo quando a próxima é outra gastaria rede e espaço para nada.
 */
export function prefetchTarget(ctx: QueueContext, from: number): number {
  const indices = caminho(ctx);
  const n = indices.length;
  const atual = indices.indexOf(from);
  for (let k = 1; k < n; k++) {
    const j = indices[(atual + k + n) % n]!;
    const tr = ctx.tracks[j]!;
    if (isLocked(tr, j, ctx.session, ctx.options)) continue;
    return ctx.cached[tr.id] ? -1 : j;
  }
  return -1;
}

/**
 * Onde a faixa atual ficou na lista nova.
 *
 * `cur` é POSIÇÃO numa lista que muda de tamanho: ao entrar, as faixas do
 * acervo entram na frente; ao sair, elas somem. Sem reancorar, o player
 * passaria a apontar para outra faixa — mostrando uma e tocando outra. O
 * `curId` existe justamente para sobreviver a isso.
 *
 * Devolve -1 quando a faixa não está mais na lista (saiu do acervo, por
 * exemplo), que é o mesmo que "nada carregado" para o resto do código.
 */
export function indexOfTrack(tracks: readonly Track[], id: string | null): number {
  if (!id) return -1;
  return tracks.findIndex((t) => t.id === id);
}
