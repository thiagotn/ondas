import { describe, expect, it } from 'vitest';
import { canDownload, isLocked, isPremium, playability } from '../access.js';
import { demoTracks } from '../catalog/demo.js';

const tracks = demoTracks();
const t = (i: number) => tracks[i]!;

describe('isPremium', () => {
  it('usa o heurístico cada-3ª quando a API não informa', () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => isPremium(t(i), i))).toEqual([
      false, false, true, false, false, true,
    ]);
  });

  it('respeita premiumEvery', () => {
    expect(isPremium(t(1), 1, { premiumEvery: 2 })).toBe(true);
    expect(isPremium(t(0), 0, { premiumEvery: 2 })).toBe(false);
  });

  it('prefere o campo da API quando existe', () => {
    expect(isPremium({ ...t(0), premium: true }, 0)).toBe(true);
    expect(isPremium({ ...t(2), premium: false }, 2)).toBe(false);
  });
});

describe('isLocked', () => {
  it('bloqueia [pro] só para visitante', () => {
    expect(isLocked(t(2), 2, null)).toBe(true);
    expect(isLocked(t(2), 2, { name: 'thiago' })).toBe(false);
    expect(isLocked(t(0), 0, null)).toBe(false);
  });
});

describe('canDownload', () => {
  it('exige sessão', () => {
    expect(canDownload(null)).toBe(false);
    expect(canDownload({ name: 'thiago' })).toBe(true);
  });
});

describe('playability', () => {
  it('nega faixa [pro] para visitante com motivo locked', () => {
    expect(playability(t(2), 2, { session: null, offline: false, cached: {} })).toEqual({
      ok: false,
      reason: 'locked',
    });
  });

  it('offline: só toca o que está no aparelho', () => {
    const ctx = { session: { name: 'thiago' }, offline: true, cached: { demo0: true } };
    expect(playability(t(0), 0, ctx).ok).toBe(true);
    expect(playability(t(1), 1, ctx)).toEqual({ ok: false, reason: 'not-cached' });
  });

  it('online e desbloqueada: libera', () => {
    expect(playability(t(1), 1, { session: null, offline: false, cached: {} }).ok).toBe(true);
  });
});
