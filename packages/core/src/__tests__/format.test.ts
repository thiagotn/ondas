import { describe, expect, it } from 'vitest';
import { dlPct, fmtMB, fmtTime, genreAnsiVar, hash, slugGenre } from '../format.js';

describe('fmtTime', () => {
  it('formata m:ss', () => {
    expect(fmtTime(0)).toBe('0:00');
    expect(fmtTime(9)).toBe('0:09');
    expect(fmtTime(214)).toBe('3:34');
    expect(fmtTime(3599)).toBe('59:59');
  });

  it('trata negativo e NaN como zero', () => {
    expect(fmtTime(-5)).toBe('0:00');
    expect(fmtTime(Number.NaN)).toBe('0:00');
  });
});

describe('fmtMB', () => {
  it('mostra uma casa decimal', () => {
    expect(fmtMB(0)).toBe('0.0 MB');
    expect(fmtMB(5 * 1048576)).toBe('5.0 MB');
    expect(fmtMB(3_670_016)).toBe('3.5 MB');
  });
});

describe('slugGenre', () => {
  it('tira acento, caixa e separadores', () => {
    expect(slugGenre('Drum & Bass')).toBe('drumbass');
    expect(slugGenre('Eletrônica')).toBe('eletronica');
    expect(slugGenre('Hip-Hop/Rap')).toBe('hiphoprap');
  });

  it('vazio virá outros', () => {
    expect(slugGenre('')).toBe('outros');
    expect(slugGenre(null)).toBe('outros');
    expect(slugGenre(undefined)).toBe('outros');
  });
});

describe('hash', () => {
  it('é determinístico e sensível à entrada', () => {
    expect(hash('techno')).toBe(hash('techno'));
    expect(hash('techno')).not.toBe(hash('ambient'));
    expect(hash('techno')).toBeGreaterThanOrEqual(0);
  });
});

describe('genreAnsiVar', () => {
  it('fica sempre entre ansi-1 e ansi-6', () => {
    for (const g of ['techno', 'ambient', 'lofi', 'house', 'indie', 'hiphop', 'synthwave', 'outros']) {
      expect(genreAnsiVar(g)).toMatch(/^var\(--ansi-[1-6]\)$/);
    }
  });
});

describe('dlPct', () => {
  it('alinha o progresso em 4 caracteres', () => {
    expect(dlPct(0.42)).toBe(' 42%');
    expect(dlPct(0.07)).toBe('  7%');
    expect(dlPct(1)).toBe('100%');
  });
});
