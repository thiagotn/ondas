import { describe, expect, it } from 'vitest';
import { JANELA_DE_RETOMADA_MS, valeRetomar, type Pendencia } from '../retomada.js';

const AGORA = 1_700_000_000_000;
const pend = (over: Partial<Pendencia> = {}): Pendencia => ({
  tipo: 'retomar',
  index: 12,
  em: AGORA,
  ...over,
});

describe('valeRetomar', () => {
  it('sem pendência não há o que retomar', () => {
    expect(valeRetomar(null, AGORA, false)).toBe(false);
  });

  it('pendência fresca com o player calado: vale', () => {
    expect(valeRetomar(pend(), AGORA + 1000, false)).toBe(true);
  });

  // O caso que só o gatilho de visibilidade produz: a música já voltou
  // sozinha, a pessoa acende a tela, e retomar reiniciaria do 0:00 a faixa
  // que estava no meio.
  it('já tocando: não mexe', () => {
    expect(valeRetomar(pend(), AGORA + 1000, true)).toBe(false);
  });

  // `visibilitychange` dispara dezenas de vezes por dia. Sem prazo, pegar o
  // telefone de noite faria voltar a faixa que parou de manhã.
  it('pendência velha caducou', () => {
    expect(valeRetomar(pend(), AGORA + JANELA_DE_RETOMADA_MS + 1, false)).toBe(false);
  });

  it('o limite exato ainda vale', () => {
    expect(valeRetomar(pend(), AGORA + JANELA_DE_RETOMADA_MS, false)).toBe(true);
  });
});
