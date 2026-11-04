import { describe, expect, it } from 'vitest';
import { demoTracks } from '../catalog/demo.js';
import { firstPlayable, isPlayable, onEnded, prefetchTarget, stepIndex } from '../queue.js';
import type { QueueContext } from '../queue.js';

const tracks = demoTracks();

const ctx = (over: Partial<QueueContext> = {}): QueueContext => ({
  tracks,
  session: { name: 'thiago' },
  cached: {},
  shuffle: false,
  repeat: false,
  cur: 0,
  ...over,
});

describe('stepIndex', () => {
  it('avança e volta circularmente', () => {
    expect(stepIndex(ctx({ cur: 0 }), 1)).toBe(1);
    expect(stepIndex(ctx({ cur: 0 }), -1)).toBe(tracks.length - 1);
    expect(stepIndex(ctx({ cur: tracks.length - 1 }), 1)).toBe(0);
  });

  it('pula faixas [pro] para visitante', () => {
    // índices 2, 5, 8, 11 são [pro] no heurístico cada-3ª
    expect(stepIndex(ctx({ session: null, cur: 1 }), 1)).toBe(3);
    expect(stepIndex(ctx({ session: null, cur: 3 }), -1)).toBe(1);
  });

  // A REGRESSÃO QUE CUSTOU A MÚSICA PARAR SOZINHA.
  //
  // Faixa que não está no aparelho continua sendo destino, e nada aqui sabe
  // o que `navigator.onLine` acha. Antes `offline: true` tirava toda faixa
  // não baixada do caminho: com o Wi-Fi dormindo (tela bloqueada no Android)
  // o navegador jurava que não havia rede, `stepIndex` não achava destino e o
  // player emudecia no fim da faixa. Ver `queue.ts` e `access.ts`.
  it('faixa fora do aparelho continua sendo destino', () => {
    expect(stepIndex(ctx({ cur: 0, cached: {} }), 1)).toBe(1);
    expect(stepIndex(ctx({ cur: 0, cached: { demo0: true, demo4: true } }), 1)).toBe(1);
  });

  it('shuffle usa o sorteio injetado', () => {
    expect(stepIndex(ctx({ shuffle: true }), 1, () => 0.5)).toBe(6);
  });

  it('lista vazia não quebra', () => {
    expect(stepIndex(ctx({ tracks: [], cur: -1 }), 1)).toBe(-1);
  });
});

describe('firstPlayable', () => {
  it('é a primeira desbloqueada', () => {
    expect(firstPlayable(ctx({ cur: -1 }))).toBe(0);
    // Sem nada baixado também há primeira: é tocável quem não está bloqueada.
    expect(firstPlayable(ctx({ cur: -1, cached: {} }))).toBe(0);
    expect(firstPlayable(ctx({ cur: -1, session: null, cached: {} }))).toBe(0);
  });
});

describe('onEnded', () => {
  it('repeat-one reinicia a mesma faixa', () => {
    expect(onEnded(ctx({ repeat: true, cur: 4 }))).toEqual({ type: 'restart' });
  });

  it('sem repeat vai para a próxima', () => {
    expect(onEnded(ctx({ cur: 4 }))).toEqual({ type: 'play', index: 5 });
  });

  // `stop` ficou para o único caso que ainda o produz: a fila inteira
  // bloqueada. Falta de rede não entra mais aqui — quem descobre que não há
  // rede é o elemento de áudio, tentando (ver `access.ts`).
  it('para só quando a fila inteira está bloqueada', () => {
    const todasPro = tracks.map((tr) => ({ ...tr, premium: true }));
    expect(onEnded(ctx({ tracks: todasPro, session: null }))).toEqual({ type: 'stop' });
    // E a mesma fila, com conta, segue andando.
    expect(onEnded(ctx({ tracks: todasPro, cur: 4 }))).toEqual({ type: 'play', index: 5 });
  });
});

describe('prefetchTarget', () => {
  it('aponta a próxima desbloqueada ainda não baixada', () => {
    expect(prefetchTarget(ctx({ cur: 0 }), 0)).toBe(1);
    expect(prefetchTarget(ctx({ session: null }), 1)).toBe(3);
  });

  it('não repete download de faixa já no aparelho', () => {
    expect(prefetchTarget(ctx({ cached: { demo1: true } }), 0)).toBe(-1);
  });
});

describe('isPlayable', () => {
  it('índice fora da lista é falso', () => {
    expect(isPlayable(ctx(), 999)).toBe(false);
  });
});

describe('a fila: o caminho é a lista da tela', () => {
  // Antes das playlists, `n` andava pelo catálogo inteiro — em `--curtidas` ele
  // já saía do recorte. Numa playlist isso seria fatal: na segunda faixa a
  // playlist já tinha acabado.
  const fila = [tracks[5]!.id, tracks[1]!.id, tracks[9]!.id];

  it('anda pela fila, na ordem dela, e devolve índice do catálogo', () => {
    expect(stepIndex(ctx({ fila, cur: 5 }), 1)).toBe(1);
    expect(stepIndex(ctx({ fila, cur: 1 }), 1)).toBe(9);
    // Circular dentro da fila, como era circular dentro do catálogo.
    expect(stepIndex(ctx({ fila, cur: 9 }), 1)).toBe(5);
    expect(stepIndex(ctx({ fila, cur: 5 }), -1)).toBe(9);
  });

  it('sem fila continua andando pelo catálogo', () => {
    expect(stepIndex(ctx({ cur: 0 }), 1)).toBe(1);
  });

  it('a faixa atual fora da fila: `n` entra pela primeira, `p` pela última', () => {
    // Tocando uma faixa e indo para um recorte onde ela não está: `n` tem de
    // entrar na lista da tela, e não ficar paralisado.
    expect(stepIndex(ctx({ fila, cur: 3 }), 1)).toBe(5);
    expect(stepIndex(ctx({ fila, cur: 3 }), -1)).toBe(9);
  });

  it('id da fila que não está no catálogo some do caminho', () => {
    // Faixa pública que saiu do trending e continua na playlist: sem isto ela
    // seria um passo que não toca nada.
    const comFantasma = [tracks[5]!.id, 'saiu-do-ar', tracks[9]!.id];
    expect(stepIndex(ctx({ fila: comFantasma, cur: 5 }), 1)).toBe(9);
  });

  it('fila que não casa com nada cai no catálogo, em vez de matar o `n`', () => {
    expect(stepIndex(ctx({ fila: ['nada', 'disso'], cur: 0 }), 1)).toBe(1);
  });

  it('pula a não-tocável dentro da fila, sem sair dela', () => {
    // Índices 2, 5, 8, 11 são [pro] no heurístico cada-3ª: o visitante pula o 5
    // e cai no 1, que é o próximo DA FILA.
    expect(stepIndex(ctx({ fila, session: null, cur: 9 }), 1)).toBe(1);
  });

  it('o shuffle sorteia dentro da fila', () => {
    // Antes ele sorteava o catálogo inteiro, o que em `--curtidas` era quase
    // sempre uma faixa fora da tela.
    const c = ctx({ fila, shuffle: true, cur: 5 });
    for (const [sorteio, esperado] of [
      [0, 5],
      [0.5, 1],
      [0.99, 9],
    ] as const) {
      expect(stepIndex(c, 1, () => sorteio)).toBe(esperado);
    }
  });

  it('firstPlayable entra pela fila', () => {
    expect(firstPlayable(ctx({ fila }))).toBe(5);
  });

  it('o buffer pré-carrega a próxima DA FILA, não a vizinha do catálogo', () => {
    expect(prefetchTarget(ctx({ fila }), 5)).toBe(1);
  });

  it('o fim da faixa segue a fila', () => {
    expect(onEnded(ctx({ fila, cur: 1 }))).toEqual({ type: 'play', index: 9 });
  });
});
