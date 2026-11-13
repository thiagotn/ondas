import { describe, expect, it } from 'vitest';
import { canDownload, canUpload, isLocked, isPremium, playability } from '../access.js';
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

describe('canUpload', () => {
  it('exige sessão', () => {
    expect(canUpload(null)).toBe(false);
  });

  it('só `false` explícito tira o envio', () => {
    expect(canUpload({ name: 'nova', podeEnviar: false })).toBe(false);
    expect(canUpload({ name: 'dona', podeEnviar: true })).toBe(true);
    // Espelho gravado antes do campo existir: é de uma conta que já enviava.
    // Se `undefined` valesse "não", o painel sumiria offline para quem sempre
    // o teve — e offline não há como corrigir.
    expect(canUpload({ name: 'antiga' })).toBe(true);
  });
});

describe('playability', () => {
  it('nega faixa [pro] para visitante com motivo locked', () => {
    expect(playability(t(2), 2, { session: null })).toEqual({
      ok: false,
      reason: 'locked',
    });
  });

  // Estar sem rede não é mais motivo de recusa: a fonte dessa informação na
  // web é `navigator.onLine`, que dá falso negativo (Wi-Fi dormindo com a tela
  // bloqueada). Quem descobre que não há rede é o elemento de áudio, tentando.
  it('não recusa faixa fora do aparelho — nem sem rede', () => {
    expect(playability(t(0), 0, { session: { name: 'thiago' } }).ok).toBe(true);
    expect(playability(t(1), 1, { session: { name: 'thiago' } }).ok).toBe(true);
  });

  it('desbloqueada: libera', () => {
    expect(playability(t(1), 1, { session: null }).ok).toBe(true);
  });
});
