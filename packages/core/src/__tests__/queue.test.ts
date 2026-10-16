import { describe, expect, it } from 'vitest';
import { demoTracks } from '../catalog/demo.js';
import { firstPlayable, isPlayable, onEnded, prefetchTarget, stepIndex } from '../queue.js';
import type { QueueContext } from '../queue.js';

const tracks = demoTracks();

const ctx = (over: Partial<QueueContext> = {}): QueueContext => ({
  tracks,
  session: { name: 'thiago' },
  offline: false,
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

  it('offline: pula as que não estão no aparelho', () => {
    const c = ctx({ cur: 0, offline: true, cached: { demo0: true, demo4: true } });
    expect(stepIndex(c, 1)).toBe(4);
  });

  it('offline sem nenhuma faixa local: não há destino', () => {
    expect(stepIndex(ctx({ offline: true, cached: {} }), 1)).toBe(-1);
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
    expect(firstPlayable(ctx({ cur: -1, offline: true, cached: { demo3: true } }))).toBe(3);
    expect(firstPlayable(ctx({ cur: -1, offline: true, cached: {} }))).toBe(-1);
  });
});

describe('onEnded', () => {
  it('repeat-one reinicia a mesma faixa', () => {
    expect(onEnded(ctx({ repeat: true, cur: 4 }))).toEqual({ type: 'restart' });
  });

  it('sem repeat vai para a próxima', () => {
    expect(onEnded(ctx({ cur: 4 }))).toEqual({ type: 'play', index: 5 });
  });

  it('para quando nada mais é tocável', () => {
    expect(onEnded(ctx({ offline: true, cached: {} }))).toEqual({ type: 'stop' });
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
