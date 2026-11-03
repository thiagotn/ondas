/**
 * O motor de tradução — `t()`, plural e número.
 *
 * Feito aqui e não com biblioteca por uma razão de lugar: 105 das ~320 strings
 * do app moram neste pacote, que é TS puro e não conhece React nem DOM. Um
 * `useTranslation()` não alcançaria `emptyText` nem a tabela de atalhos, e
 * trazer i18next puro junto para cobrir o core seria duas ferramentas para um
 * app com três idiomas e nenhum plural irregular. `Intl.PluralRules` e
 * `Intl.NumberFormat` já vêm no navegador e cobrem pt/en/es inteiros.
 *
 * O idioma é de MÓDULO, e não um parâmetro de cada função. Isso só é seguro
 * porque trocar de idioma navega (ver `useIdioma` na web): o valor é escrito
 * uma vez no boot e não muda enquanto a página vive. Fosse um seletor que
 * re-renderiza, este global seria a origem de telas meio traduzidas.
 */

export type Locale = 'pt-BR' | 'en' | 'es';

export const LOCALES: readonly Locale[] = ['pt-BR', 'en', 'es'];

/** O que a pessoa lê no seletor — cada idioma no próprio idioma. */
export const NOMES_DE_IDIOMA: Record<Locale, string> = {
  'pt-BR': 'português (brasil)',
  en: 'english',
  es: 'español',
};

/** Uma frase, ou as duas formas que o plural precisa. */
export type Frase = string | { readonly one: string; readonly other: string };

export type Params = Record<string, string | number>;

let atual: Locale = 'pt-BR';

/** O idioma de agora. */
export function idioma(): Locale {
  return atual;
}

/**
 * Fixa o idioma. Chamado uma vez, no boot, antes de desenhar qualquer coisa.
 */
export function definirIdioma(locale: Locale): void {
  atual = locale;
  plural = new Intl.PluralRules(locale);
  numero = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  umDecimal = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

let plural = new Intl.PluralRules(atual);
let numero = new Intl.NumberFormat(atual, { maximumFractionDigits: 1 });
let umDecimal = new Intl.NumberFormat(atual, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * A forma do plural para `n`.
 *
 * Zero é plural, e isso é uma DIVERGÊNCIA deliberada do CLDR. A regra do
 * português classifica `0` como `one` (`i = 0..1`), o que daria "0 faixa" —
 * e ninguém escreve assim no Brasil. O código que havia aqui antes usava
 * `n === 1`, ou seja, já tratava zero como plural, e a tela sempre disse
 * "0 faixas". Em inglês e espanhol o CLDR já devolve `other` para zero, então
 * esta linha só muda o português, e muda para o que ele sempre foi.
 */
function forma(n: number): 'one' | 'other' {
  if (n === 0) return 'other';
  return plural.select(n) === 'one' ? 'one' : 'other';
}

/** Número no formato do idioma, sem decimal à toa: `3,5`, `24`. */
export function fmtNumero(n: number): string {
  return numero.format(n);
}

/**
 * Número com UM decimal, sempre: `0,0`, `3,5`, `4,0`.
 *
 * Separado de `fmtNumero` por causa do alinhamento: o app é monoespaçado, e
 * uma coluna de tamanhos que alterna entre `0 MB` e `3,5 MB` dança. Contagem
 * (`24 faixas`) usa o outro, que não inventa um `,0`.
 */
export function fmtUmDecimal(n: number): string {
  return umDecimal.format(n);
}

/**
 * Resolve uma frase do catálogo.
 *
 * `params.n` tem dois papéis: escolhe a forma do plural E fica disponível como
 * `{n}` no texto. É a única chave com significado próprio.
 */
export function resolver(frase: Frase | undefined, params?: Params): string {
  // `frase` indefinida só acontece quando a CHAVE não existe, e o typecheck
  // impede isso no código — mas não impede num DADO que virou chave. Foi o
  // que aconteceu: `catalogSourceLabel` monta `fonte.<origem>`, e o catálogo
  // de 24h guardado no IndexedDB ainda trazia a origem no formato velho
  // (`'audius api (ao vivo)'`), gerando uma chave inexistente. O `undefined`
  // estourava dentro do render e levava a tela inteira junto — fundo do tema
  // e mais nada.
  //
  // Nenhuma frase vale uma tela em branco. Aqui ela degrada para vazio, e
  // quem monta chave a partir de dado valida antes (ver `catalogSourceLabel`).
  if (frase === undefined) return '';
  const texto = typeof frase === 'string' ? frase : frase[forma(Number(params?.n ?? 0))];

  if (!params) return texto;
  return texto.replace(/\{(\w+)\}/g, (inteiro, chave: string) => {
    const valor = params[chave];
    if (valor === undefined) return inteiro;
    return typeof valor === 'number' ? fmtNumero(valor) : valor;
  });
}
