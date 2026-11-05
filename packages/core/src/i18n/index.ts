import { EN } from './en.js';
import { ES } from './es.js';
import { idioma, resolver, type Frase, type Locale, type Params } from './motor.js';
import { PT_BR, type Chave } from './pt-BR.js';

export {
  BANDEIRAS,
  definirIdioma,
  fmtNumero,
  fmtUmDecimal,
  idioma,
  LOCALES,
  NOMES_DE_IDIOMA,
  type Locale,
  type Params,
} from './motor.js';
export type { Chave } from './pt-BR.js';

const CATALOGOS: Record<Locale, Record<Chave, Frase>> = {
  'pt-BR': PT_BR,
  en: EN,
  es: ES,
};

/**
 * A frase de `chave` no idioma de agora.
 *
 * Chave que não existe não compila — elas saem de `typeof PT_BR`. É por isso
 * que não há caminho de erro aqui: o `typecheck` é o teste.
 */
export function t(chave: Chave, params?: Params): string {
  return resolver(CATALOGOS[idioma()][chave], params);
}

/**
 * A frase de `chave` num idioma QUALQUER, e não no de agora.
 *
 * Existe para o seletor de idioma, que mostra cada opção na língua dela.
 */
export function tEm(locale: Locale, chave: Chave, params?: Params): string {
  return resolver(CATALOGOS[locale][chave], params);
}

/**
 * A frase de `chave` partida em volta de um marcador: `[antes, depois]`.
 *
 * Existe para o pedaço do MEIO virar outra coisa na tela — um link, um botão —
 * sem que a frase saia do catálogo em dois pedaços. Quebrá-la em
 * `sobre.texto2Antes`/`...Depois` amarraria a tradução à ordem das palavras do
 * português, e `{autor}` em espanhol não cai no mesmo lugar.
 *
 * Funciona porque `resolver` devolve o marcador LITERAL quando o parâmetro não
 * vem (ver `motor.ts`): a frase chega inteira, com `{marca}` ainda nela, e o
 * corte é feito aqui. Marcador ausente devolve a frase toda e um vazio — a tela
 * perde o link, nunca o texto.
 */
export function tAoRedor(chave: Chave, marca: string): [string, string] {
  const texto = t(chave);
  const alvo = `{${marca}}`;
  const i = texto.indexOf(alvo);
  if (i < 0) return [texto, ''];
  return [texto.slice(0, i), texto.slice(i + alvo.length)];
}

/**
 * O código de erro da API → a frase.
 *
 * Código desconhecido devolve `null` em vez de inventar: quem chama cai na
 * frase que o servidor mandou (pt-BR), que é a reserva combinada em
 * `erros.go`. É o que faz uma PWA velha sobreviver a um erro novo.
 */
export function tErro(codigo: string | undefined, params?: Params): string | null {
  if (!codigo) return null;
  const chave = ('erro.' + codigo) as Chave;
  return chave in PT_BR ? resolver(CATALOGOS[idioma()][chave], params) : null;
}
