import { describe, expect, it } from 'vitest';
import { atalhos, grupos, legenda } from '../shortcuts.js';

describe('atalhos', () => {
  it('nenhuma tecla aparece duas vezes', () => {
    const teclas = atalhos(true).map((a) => a.tecla);
    expect(new Set(teclas).size).toBe(teclas.length);
  });

  it('a simulação de rede só existe no build de dev', () => {
    expect(atalhos(true).some((a) => a.tecla === 'o')).toBe(true);
    expect(atalhos(false).some((a) => a.tecla === 'o')).toBe(false);
  });

  it('em produção nada do grupo dev escapa', () => {
    expect(atalhos(false).some((a) => a.grupo === 'dev')).toBe(false);
  });

  it('todo atalho cai num grupo que a janela sabe desenhar', () => {
    const conhecidos = new Set(grupos().map(([id]) => id));
    for (const a of atalhos(true)) expect(conhecidos.has(a.grupo)).toBe(true);
  });

  it('a janela se lista — senão ninguém acha o caminho de volta', () => {
    const teclas = atalhos(false).map((a) => a.tecla);
    expect(teclas).toContain('? ou 6');
    expect(teclas).toContain('esc');
  });

  it('os dois caminhos de teclado até um recorte estão na janela', () => {
    const teclas = atalhos(false).map((a) => a.tecla);
    expect(teclas).toContain('[/]');
    expect(teclas).toContain(':recorte');
    // E não engoliram a linha do número, que divide o `:` com ela.
    expect(teclas).toContain(':nº');
  });

  it('a legenda do rodapé é mais curta que a referência', () => {
    expect(legenda().length).toBeLessThan(atalhos(false).length);
  });
});
