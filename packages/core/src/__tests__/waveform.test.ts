import { describe, expect, it } from 'vitest';
import {
  ALTURA,
  barCount,
  bufferBar,
  codificarPicos,
  decodificarPicos,
  NIVEL_LISO,
  PASSO,
  PICOS_POR_FAIXA,
  picosLisos,
  reamostrarPicos,
  wavePaths,
} from '../waveform.js';

describe('codificar/decodificar picos', () => {
  it('sobrevive à ida e volta dentro da resolução de 6 bits', () => {
    const origem = [0, 0.25, 0.5, 0.75, 1];
    const volta = decodificarPicos(codificarPicos(origem))!;
    expect(volta).toHaveLength(origem.length);
    for (let i = 0; i < origem.length; i++) {
      expect(volta[i]!).toBeCloseTo(origem[i]!, 1);
    }
  });

  it('os extremos são exatos', () => {
    expect(decodificarPicos(codificarPicos([0, 1]))).toEqual([0, 1]);
  });

  it('um caractere por pico', () => {
    expect(codificarPicos(new Array(PICOS_POR_FAIXA).fill(0.5))).toHaveLength(PICOS_POR_FAIXA);
  });

  it('satura fora de 0..1 em vez de sair do alfabeto', () => {
    expect(decodificarPicos(codificarPicos([-3, 7]))).toEqual([0, 1]);
  });

  it('faixa sem picos devolve null, não barra vazia', () => {
    expect(decodificarPicos(undefined)).toBeNull();
    expect(decodificarPicos('')).toBeNull();
  });

  it('caractere estranho zera só ele', () => {
    expect(decodificarPicos('A*_')).toEqual([0, 0, 1]);
  });
});

describe('reamostrarPicos', () => {
  it('entrega exatamente a quantidade de barras pedida', () => {
    const picos = new Array(PICOS_POR_FAIXA).fill(0.5);
    for (const n of [12, 37, 100, 180, 200]) {
      expect(reamostrarPicos(picos, n)).toHaveLength(n);
    }
  });

  it('reduzindo, guarda o pico do trecho e não a média', () => {
    // Um transiente sozinho num trecho em silêncio: com média ele sumiria.
    const picos = [0, 0, 1, 0, 0, 0, 0, 0];
    expect(reamostrarPicos(picos, 2)).toEqual([1, 0]);
  });

  it('não inventa detalhe quando pedem mais barras que picos', () => {
    expect(reamostrarPicos([0, 1], 4)).toEqual([0, 0, 1, 1]);
  });

  it('aguenta pedido degenerado', () => {
    expect(reamostrarPicos([0.5], 0)).toEqual([]);
    expect(reamostrarPicos([], 10)).toEqual([]);
  });
});

describe('barCount', () => {
  it('uma barra a cada três pixels', () => {
    expect(barCount(300)).toBe(100);
    expect(barCount(540)).toBe(180);
  });

  it('não passa da resolução que o worker mede', () => {
    expect(barCount(4000)).toBe(PICOS_POR_FAIXA);
  });

  it('nunca desce de 12 barras, nem na caixa não medida', () => {
    expect(barCount(0)).toBe(12);
    expect(barCount(-50)).toBe(12);
  });
});

describe('picosLisos', () => {
  it('é a mesma altura em todas as barras', () => {
    expect(new Set(picosLisos(40))).toEqual(new Set([NIVEL_LISO]));
  });

  it('fica baixo o bastante para não passar por som', () => {
    expect(NIVEL_LISO).toBeLessThan(0.5);
  });
});

describe('wavePaths', () => {
  const picos = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];

  it('cada barra aparece em exatamente um dos três caminhos', () => {
    const d = wavePaths(picos, 0.5, 0.8, false);
    const traços = (s: string) => (s.match(/M/g) ?? []).length;
    expect(traços(d.tocado)).toBe(5);
    expect(traços(d.buffer)).toBe(3);
    expect(traços(d.resto)).toBe(2);
  });

  it('sem reflexo os caminhos do eco saem vazios', () => {
    const d = wavePaths(picos, 0.5, 0.5, false);
    expect(d.ecoTocado + d.ecoBuffer + d.ecoResto).toBe('');
    expect(d.altura).toBe(ALTURA);
  });

  it('com reflexo a caixa cresce e o eco desenha para baixo', () => {
    const d = wavePaths(picos, 1, 1, true);
    expect(d.altura).toBeGreaterThan(ALTURA);
    expect(d.ecoTocado).not.toBe('');
    // `V<y>` abaixo da base do eco: o reflexo cresce no sentido contrário.
    const [, base, ponta] = /M[\d.]+,([\d.]+)V([\d.]+)/.exec(d.ecoTocado)!;
    expect(Number(ponta)).toBeGreaterThan(Number(base));
  });

  it('a largura segue o passo das barras', () => {
    expect(wavePaths(picos, 0, 0, false).largura).toBe(picos.length * PASSO);
  });

  it('silêncio ainda deixa fio, senão a barra parece furada', () => {
    const d = wavePaths([0], 0, 0, false);
    const [, base, ponta] = /M[\d.]+,([\d.]+)V([\d.]+)/.exec(d.resto)!;
    expect(Number(base) - Number(ponta)).toBeGreaterThan(0);
  });

  it('o cursor acompanha a fração tocada e satura nas pontas', () => {
    expect(wavePaths(picos, 0.5, 1, false).cursorX).toBe((picos.length * PASSO) / 2);
    expect(wavePaths(picos, 2, 2, false).cursorX).toBe(picos.length * PASSO);
    expect(wavePaths(picos, -1, 0, false).cursorX).toBe(0);
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
