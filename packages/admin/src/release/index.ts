import type { Release } from '@ondas/core';
import notas from './notas.json';

/**
 * As notas de versão DO PAINEL — a fonte de onde `pnpm release` tira a versão
 * deste pacote e gera o `CHANGELOG.md` ao lado.
 *
 * É um arquivo separado do das notas do app (`@ondas/core`) porque são dois
 * sistemas: o que muda aqui não muda nada para quem ouve música, e a nota do
 * painel não deve ir para o bundle que todo visitante baixa. O formato é o
 * mesmo — uma entrada por entrega, a mais nova no TOPO, cada item nos três
 * idiomas — e por isso o tipo é o do core, importado e não copiado.
 */
export const RELEASES: readonly Release[] = notas;
