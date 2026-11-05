import notas from './notas.json';
import { idioma, type Locale } from '../i18n/motor.js';

/**
 * As notas de versão — a fonte única de onde saem três coisas.
 *
 * O dado mora num JSON, e não num `.ts`, porque ele é lido por dois mundos: o
 * bundle (este módulo, que desenha a página `/changelog`) e `scripts/release.mjs`,
 * um script node puro que escreve a versão nos `package.json` e gera o
 * `CHANGELOG.md`. TypeScript num script fora do bundler exigiria carregar um
 * compilador só para isto; JSON os dois leem sem ferramenta nenhuma.
 *
 * O preço do JSON é não ter comentário, e é por isso que o formato está
 * explicado aqui: uma entrada por release, a mais nova no TOPO, cada item
 * escrito nos três idiomas — a mesma regra dos catálogos de `i18n`, porque uma
 * nota meio traduzida é exatamente o que o resto do app não faz.
 *
 * A versão que o app MOSTRA (`ondas --about`, tela de login) não sai daqui: ela
 * vem de `__APP_VERSION__`, que o Vite lê do `package.json`. Quem mantém os dois
 * em sincronia é `pnpm release`, e quem reclama quando eles divergem é
 * `release.test.ts`.
 */
export interface Release {
  /** SemVer, sem o `v`: `1.1.0`. */
  readonly versao: string;
  /** A data da entrega, `YYYY-MM-DD`. */
  readonly data: string;
  readonly itens: readonly ItemDeRelease[];
}

/** Uma linha da nota, nos três idiomas. */
export type ItemDeRelease = Readonly<Record<Locale, string>>;

/** Todos os releases, do mais novo para o mais velho. */
export const RELEASES: readonly Release[] = notas;

/**
 * A versão do release mais recente.
 *
 * Devolve vazio numa lista vazia em vez de estourar: é o mesmo princípio de
 * `resolver` no i18n — nenhum dado de catálogo vale uma tela em branco.
 */
export function versaoAtual(): string {
  return RELEASES[0]?.versao ?? '';
}

/** Os itens de um release no idioma de agora (ou noutro, se pedido). */
export function itensDe(release: Release, locale: Locale = idioma()): readonly string[] {
  return release.itens.map((item) => item[locale]);
}
