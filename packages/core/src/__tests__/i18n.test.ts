import { afterEach, describe, expect, it } from 'vitest';
import {
  catalogSourceLabel,
  definirIdioma,
  emptyText,
  fmtMB,
  idioma,
  librarySegmentChip,
  librarySegmentSlug,
  LOCALES,
  promptLine,
  t,
  tAoRedor,
  tErro,
} from '../index.js';
import { EN } from '../i18n/en.js';
import { ES } from '../i18n/es.js';
import { PT_BR } from '../i18n/pt-BR.js';

// Cada teste deixa o idioma como achou: ele é global de módulo (ver
// `i18n/motor.ts`), então vazar daqui contamina os outros arquivos.
afterEach(() => definirIdioma('pt-BR'));

describe('catálogos', () => {
  it('os três têm exatamente as mesmas chaves', () => {
    const pt = Object.keys(PT_BR).sort();
    expect(Object.keys(EN).sort()).toEqual(pt);
    expect(Object.keys(ES).sort()).toEqual(pt);
  });

  it('nenhuma frase ficou vazia', () => {
    for (const [nome, cat] of [
      ['pt-BR', PT_BR],
      ['en', EN],
      ['es', ES],
    ] as const) {
      for (const [chave, frase] of Object.entries(cat)) {
        const partes = typeof frase === 'string' ? [frase] : [frase.one, frase.other];
        for (const p of partes) expect(p, `${nome}/${chave}`).not.toBe('');
      }
    }
  });

  it('o que tem plural num idioma tem nos três', () => {
    for (const chave of Object.keys(PT_BR) as (keyof typeof PT_BR)[]) {
      const forma = (c: Record<string, unknown>) => typeof c[chave] === 'string';
      expect(forma(EN), chave).toBe(forma(PT_BR));
      expect(forma(ES), chave).toBe(forma(PT_BR));
    }
  });

  it('todo `{param}` de uma frase aparece nas outras duas', () => {
    const params = (f: unknown): string[] => {
      const texto = typeof f === 'string' ? f : Object.values(f as object).join(' ');
      return [...texto.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    };
    for (const chave of Object.keys(PT_BR) as (keyof typeof PT_BR)[]) {
      const esperado = [...new Set(params(PT_BR[chave]))];
      expect([...new Set(params(EN[chave]))], `en/${chave}`).toEqual(esperado);
      expect([...new Set(params(ES[chave]))], `es/${chave}`).toEqual(esperado);
    }
  });
});

describe('plural', () => {
  it('zero é plural nos três — o CLDR do português discorda, e o uso manda', () => {
    definirIdioma('pt-BR');
    expect(t('prompt.faixas', { n: 0 })).toBe('0 faixas');
    definirIdioma('en');
    expect(t('prompt.faixas', { n: 0 })).toBe('0 tracks');
    definirIdioma('es');
    expect(t('prompt.faixas', { n: 0 })).toBe('0 pistas');
  });

  it('um é singular, dois é plural', () => {
    definirIdioma('pt-BR');
    expect(t('prompt.faixas', { n: 1 })).toBe('1 faixa');
    expect(t('prompt.faixas', { n: 2 })).toBe('2 faixas');
    definirIdioma('en');
    expect(t('prompt.faixas', { n: 1 })).toBe('1 track');
    expect(t('prompt.faixas', { n: 2 })).toBe('2 tracks');
  });
});

describe('número', () => {
  it('o separador decimal acompanha o idioma', () => {
    definirIdioma('pt-BR');
    expect(fmtMB(3.5 * 1048576)).toBe('3,5 MB');
    definirIdioma('en');
    expect(fmtMB(3.5 * 1048576)).toBe('3.5 MB');
    definirIdioma('es');
    expect(fmtMB(3.5 * 1048576)).toBe('3,5 MB');
  });
});

describe('o vocabulário de terminal acompanha a prosa', () => {
  it('o chip muda de idioma, e o slug da URL não', () => {
    definirIdioma('pt-BR');
    expect(librarySegmentChip('liked')).toBe('curtidas');
    definirIdioma('en');
    expect(librarySegmentChip('liked')).toBe('liked');
    definirIdioma('es');
    expect(librarySegmentChip('liked')).toBe('megusta');
    // O slug é id que atravessa para a API Go: ele NÃO acompanha.
    for (const l of LOCALES) {
      definirIdioma(l);
      expect(librarySegmentSlug('acervo')).toBe('archive');
    }
  });

  it('o prompt inteiro muda de idioma', () => {
    definirIdioma('en');
    const linha = promptLine({
      tab: 'home',
      who: 'visitor@ondas',
      genre: 'all',
      q: '',
      seg: 'acervo',
      count: 4,
      source: 'audius',
    });
    expect(linha.cwd).toBe('~/trending');
    expect(linha.cmd).toBe('ondas trending --genre=all');
    expect(linha.comment).toBe('4 tracks · source: audius api (live)');
  });

  it('a lista vazia cita o botão pelo nome em qualquer idioma', () => {
    definirIdioma('es');
    const texto = emptyText({
      tab: 'library',
      seg: 'acervo',
      q: '',
      loading: false,
      user: { name: 'a' },
    });
    // O nome do botão é parâmetro, então é o MESMO nos três — senão a frase
    // mandaria apertar algo que não existe.
    expect(texto).toContain('[+ arquivo]');
  });
});

describe('erro da API', () => {
  it('o código vira frase no idioma de agora', () => {
    definirIdioma('en');
    expect(tErro('playlist_nome_em_uso')).toBe('a playlist with that name already exists');
    definirIdioma('es');
    expect(tErro('playlist_nome_em_uso')).toBe('ya existe una lista con ese nombre');
  });

  it('os números do servidor são formatados no idioma', () => {
    definirIdioma('pt-BR');
    expect(tErro('senha_curta', { minimo: 8 })).toBe('senha precisa de 8+ caracteres');
  });

  it('código desconhecido devolve null — quem chama cai na frase do servidor', () => {
    expect(tErro('um_erro_que_ainda_nao_existe')).toBeNull();
    expect(tErro(undefined)).toBeNull();
  });
});

describe('frase partida em volta de um marcador', () => {
  it('o nome do autor sai do meio da frase nos três idiomas', () => {
    for (const l of LOCALES) {
      definirIdioma(l);
      const [antes, depois] = tAoRedor('sobre.texto2', 'autor');
      // Remontada, ela é a frase inteira: o corte não come nem inventa texto.
      expect(antes + '@thiagotn' + depois, l).toBe(t('sobre.texto2', { autor: '@thiagotn' }));
      expect(antes + depois, l).not.toContain('{autor}');
      // Em espanhol o nome não cai no mesmo lugar que em português — é por isso
      // que o marcador mora no catálogo e não no componente.
      expect(antes, l).not.toBe('');
    }
  });

  it('marcador ausente devolve a frase toda — a tela perde o link, não o texto', () => {
    definirIdioma('pt-BR');
    expect(tAoRedor('sobre.texto1', 'autor')).toEqual([t('sobre.texto1'), '']);
  });
});

describe('idioma()', () => {
  it('devolve o que foi fixado', () => {
    definirIdioma('es');
    expect(idioma()).toBe('es');
  });
});

/**
 * O caso que derrubou a produção.
 *
 * `Catalog.source` deixou de ser frase e virou código, mas o react-query
 * guarda o catálogo por 24h no IndexedDB — então, logo depois do deploy, o
 * app novo recebia a origem no formato velho. `catalogSourceLabel` montava
 * uma chave inexistente, `t()` devolvia `undefined` e o acesso à forma do
 * plural estourava DENTRO do render: fundo do tema e mais nada.
 *
 * O dado que atravessa disco é entrada externa, mesmo vindo de nós.
 */
describe('dado persistido num formato que o código não conhece mais', () => {
  it('a origem no formato velho não derruba a tela', () => {
    const velho = 'audius api (ao vivo)' as never;
    expect(() => catalogSourceLabel(velho)).not.toThrow();
    expect(catalogSourceLabel(velho)).toBe('');
  });

  it('nem quando ela chega pelo prompt, que é quem desenha a home', () => {
    expect(() =>
      promptLine({
        tab: 'home',
        who: 'visitante@ondas',
        genre: 'tudo',
        q: '',
        seg: 'acervo',
        count: 4,
        source: 'audius api (ao vivo)' as never,
      }),
    ).not.toThrow();
  });

  it('e a origem conhecida continua virando frase', () => {
    definirIdioma('pt-BR');
    expect(catalogSourceLabel('audius')).toBe('audius api (ao vivo)');
  });
});
