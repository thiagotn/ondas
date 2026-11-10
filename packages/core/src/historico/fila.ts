/**
 * O histórico: o retrato de uma faixa ouvida, a fila do que ainda não subiu, e
 * a lista que a tela desenha.
 */
import type { ItemDoHistorico } from '../ports/historico.js';
import type { Track } from '../types.js';

/**
 * Quantas faixas esperam na fila, no máximo. É o teto de um pedido do servidor
 * (`maxItensPorPedido` em `api/internal/httpapi/history.go`): a fila sobe
 * inteira numa viagem, e uma fila maior que o teto levaria 400 para sempre.
 * Quem ouve mais de cinquenta faixas sem rede perde as mais antigas da fila.
 */
export const MAX_NA_FILA = 50;

/** O teto de título e artista no servidor (`maxRunasDoRetrato`), em caracteres. */
const MAX_DO_RETRATO = 200;

/**
 * O retrato de uma faixa para o histórico.
 *
 * Corta título e artista no teto do servidor — por caractere, e não por
 * `slice`, que partiria um emoji ao meio. Sem o corte, uma faixa de título
 * enorme faria o lote inteiro voltar 400 e a fila nunca mais subiria.
 */
export function retratoDe(track: Track, agora: number): ItemDoHistorico {
  const cortar = (s: string): string => [...s].slice(0, MAX_DO_RETRATO).join('');
  return {
    trackId: track.id,
    titulo: cortar(track.title),
    artista: cortar(track.artist),
    dur: Math.max(0, Math.round(track.dur) || 0),
    em: agora,
  };
}

/**
 * Põe uma faixa na fila. A mesma faixa duas vezes vira uma, com a escuta mais
 * recente — é o que o servidor guardaria de qualquer jeito (uma linha por
 * faixa), e o que mantém a fila dentro do teto para quem ouve em repetição.
 */
export function enfileirar(
  fila: readonly ItemDoHistorico[],
  item: ItemDoHistorico,
): ItemDoHistorico[] {
  const semEla = fila.filter((x) => x.trackId !== item.trackId);
  semEla.push(item);
  return semEla.slice(-MAX_NA_FILA);
}

/**
 * O que sobrou da fila depois de uma subida bem-sucedida.
 *
 * Não é "zera a fila", pelo mesmo motivo das curtidas: o que entrou durante o
 * voo precisa sobreviver. E a comparação é por faixa E instante — a mesma
 * faixa ouvida de novo enquanto a anterior subia é uma escuta nova, e fica.
 */
export function semOQueSubiu(
  atual: readonly ItemDoHistorico[],
  enviada: readonly ItemDoHistorico[],
): ItemDoHistorico[] {
  const subiu = new Set(enviada.map((x) => `${x.em}:${x.trackId}`));
  return atual.filter((x) => !subiu.has(`${x.em}:${x.trackId}`));
}

/**
 * Lê itens que vieram de fora — a fila no disco, ou a resposta do servidor.
 * Item torto é descartado sozinho; o resto da lista segue.
 */
export function leItens(bruto: unknown): ItemDoHistorico[] {
  if (!Array.isArray(bruto)) return [];
  const itens: ItemDoHistorico[] = [];
  for (const x of bruto as unknown[]) {
    if (!x || typeof x !== 'object') continue;
    const i = x as Partial<Record<keyof ItemDoHistorico, unknown>>;
    if (typeof i.trackId !== 'string' || !i.trackId) continue;
    if (typeof i.em !== 'number' || !Number.isFinite(i.em) || i.em <= 0) continue;
    itens.push({
      trackId: i.trackId,
      titulo: typeof i.titulo === 'string' ? i.titulo : '',
      artista: typeof i.artista === 'string' ? i.artista : '',
      dur: typeof i.dur === 'number' && Number.isFinite(i.dur) && i.dur > 0 ? i.dur : 0,
      em: i.em,
    });
  }
  return itens;
}

/**
 * O histórico com a fila que ainda não subiu por cima — o que a tela mostra.
 *
 * Sem isto, a faixa ouvida no avião só apareceria em `--historico` quando a
 * rede voltasse, e o recorte pareceria quebrado justamente offline.
 */
export function comAFila(
  servidor: readonly ItemDoHistorico[],
  fila: readonly ItemDoHistorico[],
): ItemDoHistorico[] {
  const porFaixa = new Map<string, ItemDoHistorico>();
  for (const item of [...servidor, ...fila]) {
    const antes = porFaixa.get(item.trackId);
    if (!antes || item.em >= antes.em) porFaixa.set(item.trackId, item);
  }
  return [...porFaixa.values()].sort((a, b) => b.em - a.em);
}

/**
 * As faixas do histórico, na ordem dele, prontas para a lista.
 *
 * Faixa que está no catálogo carregado sai como ela é — capa, stream, tudo. A
 * que não está sai como RETRATO: só título, artista e duração, sem `stream`
 * nem capa. É uma `Track` de verdade para a lista poder desenhá-la, e quem
 * distingue as duas é a tela, pela ausência da faixa no catálogo.
 */
export function faixasDoHistorico(
  itens: readonly ItemDoHistorico[],
  tracks: readonly Track[],
): Track[] {
  const porId = new Map(tracks.map((t) => [t.id, t]));
  return itens.map(
    (item) =>
      porId.get(item.trackId) ?? {
        id: item.trackId,
        title: item.titulo,
        artist: item.artista,
        genre: '',
        dur: item.dur,
        art: '',
        stream: '',
      },
  );
}
