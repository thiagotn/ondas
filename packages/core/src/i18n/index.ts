import { EN } from './en.js';
import { ES } from './es.js';
import { idioma, resolver, type Frase, type Locale, type Params } from './motor.js';
import { PT_BR, type Chave } from './pt-BR.js';

export {
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
