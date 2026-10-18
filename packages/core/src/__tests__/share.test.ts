import { describe, expect, it } from 'vitest';
import {
  parseTrackPath,
  parseTrackToken,
  slugify,
  TRACK_PATH_PREFIX,
  trackPath,
  trackUrl,
} from '../share.js';

const PUBLICA = { id: 'J72oWO6', title: 'Concreto Molhado', artist: 'Turbo Vício' };
const PRIVADA = {
  id: 'acervo:11111111-1111-4111-8111-111111111111',
  title: 'Fita Caseira',
  artist: 'Eu Mesmo',
  source: 'acervo' as const,
};

describe('slugify', () => {
  it('tira acento e troca o resto por hífen', () => {
    expect(slugify('Turbo Vício Concreto Molhado')).toBe('turbo-vicio-concreto-molhado');
  });

  it('mantém os hífens que já existem no título', () => {
    expect(slugify('Lo-Fi — Parte 2')).toBe('lo-fi-parte-2');
  });

  it('nunca termina em hífen, nem quando corta', () => {
    const longo = slugify('palavra '.repeat(40));
    expect(longo.length).toBeLessThanOrEqual(60);
    expect(longo.endsWith('-')).toBe(false);
  });

  it('corta numa fronteira de palavra', () => {
    expect(slugify('abcdefghij '.repeat(10))).not.toMatch(/abcde$/);
  });

  it('texto sem nada aproveitável vira `faixa`', () => {
    expect(slugify('夜の曲')).toBe('faixa');
    expect(slugify('!!! ???')).toBe('faixa');
    expect(slugify('')).toBe('faixa');
  });
});

describe('trackPath — faixa pública', () => {
  it('é slug + id', () => {
    expect(trackPath(PUBLICA)).toBe('/t/turbo-vicio-concreto-molhado-J72oWO6');
  });

  it('o id não é achatado para minúsculo', () => {
    // O hashid do Audius diferencia maiúsculas: `J72oWO6` e `j72owo6` são
    // faixas diferentes. Baixar a caixa aqui quebraria o link calado.
    expect(trackPath(PUBLICA)).toContain('J72oWO6');
  });

  it('o link inteiro junta a origem sem barra dobrada', () => {
    expect(trackUrl(PUBLICA, 'https://music.thiagotn.com')).toBe(
      'https://music.thiagotn.com/t/turbo-vicio-concreto-molhado-J72oWO6',
    );
    expect(trackUrl(PUBLICA, 'https://music.thiagotn.com/')).toBe(
      'https://music.thiagotn.com/t/turbo-vicio-concreto-molhado-J72oWO6',
    );
  });
});

describe('trackPath — faixa do acervo', () => {
  it('é o sigilo mais o uuid sem hífen', () => {
    expect(trackPath(PRIVADA)).toBe('/t/_11111111111141118111111111111111');
  });

  it('NÃO carrega título nem artista na URL', () => {
    // A razão de a faixa privada não ter slug: quem recebe o link não pode
    // descobrir o que é a faixa só de olhar o endereço.
    const caminho = trackPath(PRIVADA);
    expect(caminho).not.toMatch(/fita/i);
    expect(caminho).not.toMatch(/caseira/i);
    expect(caminho).not.toMatch(/eu-mesmo/i);
  });

  it('reconhece pelo prefixo do id mesmo sem `source`', () => {
    expect(trackPath({ id: PRIVADA.id, title: 'x', artist: 'y' })).toBe(trackPath(PRIVADA));
  });
});

describe('parseTrackToken', () => {
  it('lê o id depois do último hífen', () => {
    expect(parseTrackToken('turbo-vicio-concreto-molhado-J72oWO6')).toBe('J72oWO6');
  });

  it('aguenta slug cheio de hífen', () => {
    expect(parseTrackToken('lo-fi-parte-2-abc123')).toBe('abc123');
  });

  it('segmento sem hífen é o id cru', () => {
    expect(parseTrackToken('J72oWO6')).toBe('J72oWO6');
  });

  it('remonta o id do acervo byte a byte', () => {
    expect(parseTrackToken('_11111111111141118111111111111111')).toBe(PRIVADA.id);
  });

  it('aceita hex maiúsculo e devolve uuid minúsculo', () => {
    expect(parseTrackToken('_AAAAAAAABBBB4CCC8DDDEEEEEEEEEEEE')).toBe(
      'acervo:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );
  });

  it('recusa o que não é token de faixa', () => {
    for (const ruim of [
      '',
      '-',
      'foo-',
      'fi', // curto demais para id público
      'foo-J72$oWO6',
      'foo-com-acento-ç',
      '_naohex',
      '_ABC', // hex curto
      '_' + '1'.repeat(33),
      'x'.repeat(200),
      null,
      undefined,
    ]) {
      expect(parseTrackToken(ruim)).toBeNull();
    }
  });
});

describe('ida e volta', () => {
  it('o caminho gerado é sempre lido de volta no mesmo id', () => {
    const faixas = [
      PUBLICA,
      PRIVADA,
      { id: 'a5aXGmz', title: 'Dobra', artist: 'Kaio Ruas' },
      { id: 'demo0', title: 'Maré Baixa', artist: 'Lia Sombra' },
      { id: '44G3vWj', title: '夜の曲', artist: '!!!' },
      { id: 'RRxymAw', title: 'x'.repeat(300), artist: 'y'.repeat(300) },
    ];
    for (const f of faixas) {
      expect(parseTrackPath(trackPath(f))).toBe(f.id);
    }
  });
});

describe('parseTrackPath', () => {
  it('só olha caminho de faixa', () => {
    expect(parseTrackPath('/t/slug-abc123')).toBe('abc123');
    expect(parseTrackPath('/')).toBeNull();
    expect(parseTrackPath('/buscar')).toBeNull();
    expect(parseTrackPath('/track/slug-abc123')).toBeNull();
    expect(parseTrackPath('/tabc123')).toBeNull();
  });

  it('tolera barra final', () => {
    expect(parseTrackPath('/t/slug-abc123/')).toBe('abc123');
  });

  it('recusa segmento a mais', () => {
    expect(parseTrackPath('/t/slug-abc123/extra')).toBeNull();
  });

  it('o prefixo é o que a rota do app declara', () => {
    expect(TRACK_PATH_PREFIX).toBe('/t/');
  });
});
