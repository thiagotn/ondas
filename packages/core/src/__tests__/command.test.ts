import { describe, expect, it } from 'vitest';
import { faixaPorNumero, parseComando } from '../command.js';
import type { Track } from '../types.js';

const faixa = (id: string): Track =>
  ({ id, title: id, artist: 'x', genre: 'lofi', dur: 60 }) as Track;

describe('parseComando', () => {
  it('lê o número com e sem o dois-pontos', () => {
    expect(parseComando(':08')).toEqual({ kind: 'faixa', numero: 8 });
    expect(parseComando('08')).toEqual({ kind: 'faixa', numero: 8 });
    expect(parseComando('8')).toEqual({ kind: 'faixa', numero: 8 });
  });

  it('aceita até três dígitos — é o que a calha de 3ch mostra', () => {
    expect(parseComando(':123')).toEqual({ kind: 'faixa', numero: 123 });
    expect(parseComando(':1234')).toBeNull();
  });

  it('ignora espaço em volta', () => {
    expect(parseComando('  :08  ')).toEqual({ kind: 'faixa', numero: 8 });
  });

  it('não existe faixa 0 — a calha começa em 01', () => {
    expect(parseComando(':0')).toBeNull();
    expect(parseComando(':00')).toBeNull();
  });

  it('o que começa por letra é o nome de um recorte, e sai cru', () => {
    // Cru de propósito: qual recorte é depende do idioma e da conta, e o
    // parser não conhece nenhum dos dois (ver `findLibrarySegment`).
    expect(parseComando(':historico')).toEqual({ kind: 'recorte', nome: 'historico' });
    expect(parseComando('hist')).toEqual({ kind: 'recorte', nome: 'hist' });
    expect(parseComando(':--curtidas')).toEqual({ kind: 'recorte', nome: '--curtidas' });
    expect(parseComando(':Histórico')).toEqual({ kind: 'recorte', nome: 'Histórico' });
    // `:ab` era lixo enquanto a linha só sabia número. Agora é um nome que
    // não casa com nada, e quem diz isso é a tela, com um aviso.
    expect(parseComando(':ab')).toEqual({ kind: 'recorte', nome: 'ab' });
  });

  it('devolve null para o que não é número nem nome', () => {
    expect(parseComando('')).toBeNull();
    expect(parseComando(':')).toBeNull();
    expect(parseComando(':8a')).toBeNull();
    expect(parseComando(':a8')).toBeNull();
    expect(parseComando(':--')).toBeNull();
    expect(parseComando(':duas palavras')).toBeNull();
    expect(parseComando(':' + 'a'.repeat(40))).toBeNull();
    expect(parseComando(':-3')).toBeNull();
    expect(parseComando(': 8')).toBeNull();
    expect(parseComando('::8')).toBeNull();
  });
});

describe('faixaPorNumero', () => {
  const tracks = [faixa('a'), faixa('b'), faixa('c')];

  it('o número da calha é 1-based', () => {
    expect(faixaPorNumero(tracks, 1)?.id).toBe('a');
    expect(faixaPorNumero(tracks, 3)?.id).toBe('c');
  });

  it('fora de alcance é undefined, nunca a vizinha', () => {
    expect(faixaPorNumero(tracks, 0)).toBeUndefined();
    expect(faixaPorNumero(tracks, 4)).toBeUndefined();
    expect(faixaPorNumero([], 1)).toBeUndefined();
  });
});
