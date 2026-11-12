import { describe, expect, it } from 'vitest';
import { decidirPrefs, lePrefs, wallEfetivo } from '../prefs.js';
import { isThemeId } from '../themes.js';

describe('lePrefs', () => {
  it('lê o que conhece', () => {
    expect(
      lePrefs({ tema: 'nord', idioma: 'es', opacity: 0.55, blur: 12, wall: 'imagem' }),
    ).toEqual({ tema: 'nord', idioma: 'es', opacity: 0.55, blur: 12, wall: 'imagem' });
  });

  it('descarta o que não conhece, em vez de trocar por um padrão', () => {
    // Tema que este build não tem é "não sei", e não "catppuccin": aplicá-lo
    // como padrão trocaria o tema da pessoa, e ainda o subiria de volta.
    expect(lePrefs({ tema: 'tema-do-futuro', idioma: 'fr', wall: 'video' })).toEqual({});
    expect(lePrefs({ tema: 12, idioma: null, opacity: '0.5', blur: NaN })).toEqual({});
  });

  it('a imagem de fundo não atravessa', () => {
    expect(lePrefs({ wall: 'imagem', wallImg: 'data:image/jpeg;base64,AAAA' })).toEqual({
      wall: 'imagem',
    });
  });

  it('põe os números na forma dos sliders', () => {
    expect(lePrefs({ opacity: 0.5499999999999999, blur: 12.4 })).toEqual({ opacity: 0.55, blur: 12 });
    expect(lePrefs({ opacity: 0.1, blur: -3 })).toEqual({ opacity: 0.3, blur: 0 });
    expect(lePrefs({ opacity: 7, blur: 99 })).toEqual({ opacity: 1, blur: 40 });
  });

  it('lixo vira vazio', () => {
    for (const lixo of [null, undefined, 'nord', 3, []]) expect(lePrefs(lixo)).toEqual({});
  });
});

describe('isThemeId', () => {
  it('só os temas que existem', () => {
    expect(isThemeId('nord')).toBe(true);
    expect(isThemeId('tema-do-futuro')).toBe(false);
    expect(isThemeId(null)).toBe(false);
  });
});

describe('wallEfetivo', () => {
  it('`imagem` sem imagem neste aparelho é exibido como capa', () => {
    expect(wallEfetivo('imagem', '')).toBe('capa');
    expect(wallEfetivo('imagem', 'data:image/jpeg;base64,AAAA')).toBe('imagem');
  });

  it('os outros dois não dependem de imagem', () => {
    expect(wallEfetivo('capa', '')).toBe('capa');
    expect(wallEfetivo('nenhum', 'data:image/jpeg;base64,AAAA')).toBe('nenhum');
  });
});

describe('decidirPrefs', () => {
  const nada = { subir: {}, aplicar: {} };

  it('servidor de antes das preferências: o aparelho segue só local', () => {
    // Nem sobe: um servidor antigo responderia 400 ao campo que não conhece.
    expect(
      decidirPrefs({
        conta: undefined,
        local: { tema: 'nord' },
        pendente: { idioma: 'en' },
        adotado: false,
      }),
    ).toEqual(nada);
  });

  it('a conta vence o aparelho — é o que faz o segundo abrir como o primeiro', () => {
    expect(
      decidirPrefs({
        conta: { tema: 'nord', blur: 4 },
        local: { tema: 'dracula' },
        pendente: {},
        adotado: true,
      }),
    ).toEqual({ subir: {}, aplicar: { tema: 'nord', blur: 4 } });
  });

  it('o que já é igual não é reaplicado', () => {
    expect(
      decidirPrefs({ conta: { tema: 'nord' }, local: { tema: 'nord' }, pendente: {}, adotado: true }),
    ).toEqual(nada);
    // Igual DEPOIS de arredondar: senão cada boot veria uma diferença.
    expect(
      decidirPrefs({
        conta: { opacity: 0.55 },
        local: { opacity: 0.5499999999999999 },
        pendente: {},
        adotado: true,
      }),
    ).toEqual(nada);
  });

  it('o gesto feito aqui e ainda não entregue vence a conta', () => {
    expect(
      decidirPrefs({
        conta: { tema: 'nord', idioma: 'en' },
        local: { tema: 'dracula', idioma: 'pt-BR' },
        pendente: { tema: 'dracula' },
        adotado: true,
      }),
      // Campo a campo: o tema pendente sobe, o idioma da conta é aplicado.
    ).toEqual({ subir: { tema: 'dracula' }, aplicar: { idioma: 'en' } });
  });

  it('primeira adoção: conta vazia recebe o que o aparelho já tinha escolhido', () => {
    expect(
      decidirPrefs({
        conta: {},
        local: { tema: 'dracula', opacity: 0.8 },
        pendente: {},
        adotado: false,
      }),
    ).toEqual({ subir: { tema: 'dracula', opacity: 0.8 }, aplicar: {} });
  });

  it('a adoção é por campo: o que a conta já tem não é sobrescrito', () => {
    expect(
      decidirPrefs({
        conta: { tema: 'nord' },
        local: { tema: 'dracula', blur: 8 },
        pendente: {},
        adotado: false,
      }),
    ).toEqual({ subir: { blur: 8 }, aplicar: { tema: 'nord' } });
  });

  it('depois de adotado, o aparelho não escreve mais por conta própria', () => {
    // É o que protege a PRÓXIMA conta que entrar neste navegador: o tema de
    // quem saiu continua na tela, mas não é gravado nela.
    expect(
      decidirPrefs({ conta: {}, local: { tema: 'dracula' }, pendente: {}, adotado: true }),
    ).toEqual(nada);
  });

  it('aparelho sem escolha nenhuma não sobe padrão', () => {
    expect(decidirPrefs({ conta: {}, local: {}, pendente: {}, adotado: false })).toEqual(nada);
  });

  it('pendente gravado por outra versão passa pela peneira', () => {
    expect(
      decidirPrefs({
        conta: { tema: 'nord' },
        local: {},
        pendente: { tema: 'tema-que-sumiu' } as never,
        adotado: true,
      }),
    ).toEqual({ subir: {}, aplicar: { tema: 'nord' } });
  });
});
