import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { definirIdioma, itensDe, LOCALES, RELEASES, versaoAtual } from '../index.js';

afterEach(() => definirIdioma('pt-BR'));

/** Um arquivo do repositório, a partir daqui (`packages/core/src/__tests__/`). */
const doRepo = (rel: string) => readFileSync(new URL('../../../../' + rel, import.meta.url), 'utf8');

const PACOTES = ['package.json', 'packages/core/package.json', 'packages/web/package.json'];

const comparar = (a: string, b: string) => {
  const [a1 = 0, a2 = 0, a3 = 0] = a.split('.').map(Number);
  const [b1 = 0, b2 = 0, b3 = 0] = b.split('.').map(Number);
  return a1 - b1 || a2 - b2 || a3 - b3;
};

describe('notas de versão', () => {
  it('toda versão é SemVer, única, e a lista desce da mais nova', () => {
    expect(RELEASES.length).toBeGreaterThan(0);
    const vistas = new Set<string>();
    for (const r of RELEASES) {
      expect(r.versao, r.versao).toMatch(/^\d+\.\d+\.\d+$/);
      expect(vistas.has(r.versao), `repetida: ${r.versao}`).toBe(false);
      vistas.add(r.versao);
    }
    for (let i = 1; i < RELEASES.length; i++) {
      const anterior = RELEASES[i - 1]!.versao;
      const atual = RELEASES[i]!.versao;
      expect(comparar(anterior, atual), `${anterior} antes de ${atual}`).toBeGreaterThan(0);
    }
  });

  it('toda data é uma data de verdade, no formato do dia', () => {
    for (const r of RELEASES) {
      expect(r.data, r.versao).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(r.data + 'T00:00:00Z').toISOString().slice(0, 10)).toBe(r.data);
    }
  });

  /**
   * A regra que o resto do app já segue nos catálogos de `i18n`: nada de tela
   * meio traduzida. Aqui ela é teste porque o tipo não alcança o JSON —
   * `notas.json` é dado, e dado que falta só aparece na tela.
   */
  it('todo item está escrito nos três idiomas', () => {
    for (const r of RELEASES) {
      expect(r.itens.length, r.versao).toBeGreaterThan(0);
      for (const item of r.itens) {
        for (const locale of LOCALES) {
          expect(item[locale]?.trim(), `${r.versao}/${locale}`).toBeTruthy();
        }
      }
    }
  });

  it('`itensDe` acompanha o idioma de agora', () => {
    const [primeiro] = RELEASES;
    definirIdioma('en');
    expect(itensDe(primeiro!)).toEqual(primeiro!.itens.map((i) => i.en));
    definirIdioma('es');
    expect(itensDe(primeiro!)).toEqual(primeiro!.itens.map((i) => i.es));
  });
});

/**
 * O ritual de entrega, travado por teste.
 *
 * A nota é a fonte única: dela `pnpm release` escreve a versão nos três
 * `package.json` (é de lá que sai o `__APP_VERSION__` que o `ondas --about`
 * mostra) e gera o `CHANGELOG.md`. Esquecer de rodar o script deixa o app
 * anunciando uma versão que a nota não conhece — e é esse o furo que os três
 * casos abaixo fecham, sem depender do passo de CI.
 */
describe('a nota, os pacotes e o CHANGELOG contam a mesma história', () => {
  it('os três `package.json` estão na versão do topo da nota', () => {
    for (const caminho of PACOTES) {
      const { version } = JSON.parse(doRepo(caminho)) as { version: string };
      expect(version, caminho).toBe(versaoAtual());
    }
  });

  it('o `CHANGELOG.md` tem a entrada da versão de agora', () => {
    const topo = RELEASES[0]!;
    expect(doRepo('CHANGELOG.md')).toContain(`## ${topo.versao} — ${topo.data}`);
  });

  it('e nenhum item em português ficou de fora dele', () => {
    const changelog = doRepo('CHANGELOG.md');
    for (const r of RELEASES) {
      for (const item of r.itens) expect(changelog, r.versao).toContain(item['pt-BR']);
    }
  });
});
