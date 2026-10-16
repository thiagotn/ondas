import { describe, expect, it } from 'vitest';
import { barCount, BLOCKS, bufferBar, miniBarCount, waveBars } from '../waveform.js';

describe('waveBars', () => {
  it('é determinística por id de faixa', () => {
    expect(waveBars('demo3', 20, 0, 0)).toEqual(waveBars('demo3', 20, 0, 0));
    expect(waveBars('demo3', 20, 0, 0)).not.toEqual(waveBars('demo4', 20, 0, 0));
  });

  it('usa só os 8 glifos de bloco', () => {
    for (const b of waveBars('demo1', 64, 0.3, 0.6)) expect(BLOCKS).toContain(b.ch);
  });

  it('colore tocado / em buffer / resto', () => {
    const bars = waveBars('demo1', 10, 0.5, 0.8);
    expect(bars[0]!.color).toBe('var(--color-accent)');
    expect(bars[4]!.color).toBe('var(--color-accent)');
    expect(bars[6]!.color).toBe('var(--color-neutral-500)');
    expect(bars[9]!.color).toBe('var(--color-neutral-800)');
  });

  it('sem faixa carregada ainda rende barras', () => {
    expect(waveBars(null, 8, 0, 0)).toHaveLength(8);
  });
});

describe('barCount', () => {
  it('é fixo no wide e proporcional no narrow', () => {
    expect(barCount(1280, true)).toBe(34);
    expect(barCount(390, false)).toBe(24);
    expect(barCount(820, false)).toBe(56);
  });

  it('nunca desce de 16 barras', () => {
    expect(barCount(280, false)).toBe(16);
    expect(barCount(0, false)).toBe(16);
  });

  it('a mini waveform segue o breakpoint', () => {
    expect(miniBarCount(true)).toBe(60);
    expect(miniBarCount(false)).toBe(22);
  });
});

describe('bufferBar', () => {
  it('soma sempre 24 caracteres', () => {
    for (const [p, b] of [[0, 0], [0.5, 0.75], [1, 1], [0.33, 0.33]] as const) {
      const bar = bufferBar(p, b);
      expect(bar.a.length + bar.b.length + bar.c.length).toBe(24);
    }
  });

  it('divide tocado, em buffer e resto', () => {
    const bar = bufferBar(0.25, 0.5);
    expect(bar.a).toBe('█'.repeat(6));
    expect(bar.b).toBe('▓'.repeat(6));
    expect(bar.c).toBe('░'.repeat(12));
  });

  it('satura fora de 0..1', () => {
    expect(bufferBar(2, 2).a).toHaveLength(24);
    expect(bufferBar(-1, -1).c).toHaveLength(24);
  });
});
