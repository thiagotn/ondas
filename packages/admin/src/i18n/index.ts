import { idioma, resolver, tErro, type Frase, type Locale, type Params } from '@ondas/core';
import { EN } from './en';
import { ES } from './es';
import { PT_BR, type Chave } from './pt-BR';

export type { Chave } from './pt-BR';

/**
 * As frases do painel, nos três idiomas da PWA.
 *
 * O catálogo é DESTE pacote, e não do `@ondas/core`: o core vai para o bundle
 * que todo visitante baixa, e nada de administração deve chegar lá. O motor
 * (`resolver`, plural, número, idioma de módulo) é o mesmo — importado, não
 * copiado.
 *
 * Vale a mesma regra do app: o idioma é fixado UMA vez, no boot, e trocar de
 * idioma recarrega a página (ver `prefs.ts`). Por isso `t()` só pode ser
 * chamado durante o render ou depois — nunca no topo de um módulo, que roda
 * antes de o idioma ser decidido.
 */
const CATALOGOS: Record<Locale, Record<Chave, Frase>> = { 'pt-BR': PT_BR, en: EN, es: ES };

export function t(chave: Chave, params?: Params): string {
  return resolver(CATALOGOS[idioma()][chave], params);
}

/**
 * A frase de uma chave montada a partir de DADO (status, ação do histórico).
 * `null` quando a chave não existe — quem chama mostra o dado cru, que é
 * melhor do que vazio quando o servidor ganha um valor que esta tela não
 * conhece.
 */
export function tSe(chave: string, params?: Params): string | null {
  return Object.prototype.hasOwnProperty.call(PT_BR, chave) ? t(chave as Chave, params) : null;
}

/**
 * A frase de um erro da API.
 *
 * Em português vale a do servidor, que é a mais específica (ele escreve em
 * pt-BR). Nos outros idiomas, a tradução do CÓDIGO quando o catálogo do app a
 * tem; sem ela, a frase do servidor mesmo — em português, mas dizendo o que
 * houve.
 */
export function tErroDaApi(codigo: string | undefined, doServidor: string): string {
  if (idioma() === 'pt-BR') return doServidor;
  return tErro(codigo) ?? doServidor;
}
