#!/usr/bin/env node
/**
 * `pnpm release` — a versão e o CHANGELOG saem da nota, não da mão.
 *
 * São DUAS linhas de entrega, porque são dois sistemas: o produto (a PWA e o
 * core que ela embarca) e o painel de administração, que é outro bundle, em
 * outro host, para outro público. Cada linha tem a sua nota, o seu número e o
 * seu CHANGELOG — uma entrega do painel não empurra a versão do app, e não
 * aparece na página `/changelog` de quem só ouve música.
 *
 * De cada nota (o formato está explicado em `packages/core/src/release/index.ts`)
 * saem os dois destinos que o JSON não alcança sozinho:
 *
 *   1. o campo `version` dos `package.json` da linha — é dele que o Vite monta
 *      o `__APP_VERSION__` que a tela mostra (`ondas --about` e login na PWA,
 *      rodapé no painel);
 *   2. o `CHANGELOG.md` da linha, para quem lê o repositório e não o app.
 *
 * Com `--check` nada é escrito: o script só confere e sai com código 1 se algum
 * destino estiver fora de sincronia. É esse o modo que o CI roda, para uma nota
 * nova sem bump (ou um bump sem nota) travar o build.
 *
 * Node puro, sem dependência: um script de release que precisa de `pnpm install`
 * para rodar é um script que não roda no dia em que o lockfile está quebrado.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';

const RAIZ = new URL('../', import.meta.url);

const LINHAS = [
  {
    nome: 'produto',
    notas: 'packages/core/src/release/notas.json',
    pacotes: ['package.json', 'packages/core/package.json', 'packages/web/package.json'],
    changelog: 'CHANGELOG.md',
    cabecalho: [
      '# Changelog',
      '',
      'Todas as entregas do ondas, da mais nova para a mais velha. As do painel de administração',
      'têm versão e arquivo próprios: [`packages/admin/CHANGELOG.md`](./packages/admin/CHANGELOG.md).',
      '',
      '**Este arquivo é gerado.** A nota se escreve em',
      '`packages/core/src/release/notas.json` e sai daqui por `pnpm release` — a mesma lista é a',
      'página `/changelog` do app, nos três idiomas. Editar este arquivo à mão é trabalho que o',
      'próximo `pnpm release` desfaz.',
      '',
    ],
  },
  {
    nome: 'admin',
    notas: 'packages/admin/src/release/notas.json',
    pacotes: ['packages/admin/package.json'],
    changelog: 'packages/admin/CHANGELOG.md',
    cabecalho: [
      '# Changelog do painel de administração',
      '',
      'Todas as entregas do painel, da mais nova para a mais velha. O painel é um sistema à parte:',
      'a versão dele não acompanha a do app, cujas entregas estão em',
      '[`CHANGELOG.md`](../../CHANGELOG.md).',
      '',
      '**Este arquivo é gerado.** A nota se escreve em',
      '`packages/admin/src/release/notas.json` e sai daqui por `pnpm release` — a mesma lista é a',
      'tela `/changelog` do painel, nos três idiomas. Editar este arquivo à mão é trabalho que o',
      'próximo `pnpm release` desfaz.',
      '',
    ],
  },
];

const SEMVER = /^\d+\.\d+\.\d+$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const IDIOMAS = ['pt-BR', 'en', 'es'];

const checando = argv.includes('--check');

/**
 * O que um JSON mal escrito faria sem isto: um `CHANGELOG` com `undefined` no
 * meio, ou uma versão que não é versão escrita nos três pacotes. Barato de
 * conferir, caro de descobrir depois.
 */
function validar(lista, nome) {
  const falhar = (msg) => falharGeral(`${nome}: ${msg}`);
  if (!Array.isArray(lista) || lista.length === 0) falhar('notas.json está vazio');
  const vistas = new Set();
  for (const r of lista) {
    if (!SEMVER.test(r.versao ?? '')) falhar(`versão inválida: ${JSON.stringify(r.versao)}`);
    if (vistas.has(r.versao)) falhar(`versão repetida: ${r.versao}`);
    vistas.add(r.versao);
    if (!DATA.test(r.data ?? '')) falhar(`data inválida em ${r.versao}: ${JSON.stringify(r.data)}`);
    if (!Array.isArray(r.itens) || r.itens.length === 0) falhar(`${r.versao} não tem itens`);
    for (const item of r.itens) {
      for (const lang of IDIOMAS) {
        if (!item?.[lang]?.trim()) falhar(`${r.versao}: item sem ${lang} — ${JSON.stringify(item)}`);
      }
    }
  }
  // Ordem decrescente: o topo é a versão de agora, e é dela que tudo sai.
  for (let i = 1; i < lista.length; i++) {
    if (comparar(lista[i - 1].versao, lista[i].versao) <= 0) {
      falhar(`fora de ordem: ${lista[i - 1].versao} antes de ${lista[i].versao}`);
    }
  }
}

function comparar(a, b) {
  const [a1, a2, a3] = a.split('.').map(Number);
  const [b1, b2, b3] = b.split('.').map(Number);
  return a1 - b1 || a2 - b2 || a3 - b3;
}

function falharGeral(msg) {
  console.error(`release: ${msg}`);
  exit(1);
}

/** O arquivo que o repositório deveria ter, dada a nota de agora. */
function changelog(linha, releases) {
  const linhas = [...linha.cabecalho];
  for (const r of releases) {
    linhas.push(`## ${r.versao} — ${r.data}`, '');
    for (const item of r.itens) linhas.push(`- ${item['pt-BR']}`);
    linhas.push('');
  }
  return linhas.join('\n');
}

const pendencias = [];
const prontas = [];

for (const linha of LINHAS) {
  const releases = JSON.parse(readFileSync(new URL(linha.notas, RAIZ), 'utf8'));
  validar(releases, linha.nome);
  const versao = releases[0].versao;
  prontas.push(`${linha.nome} ${versao}`);

  for (const caminho of linha.pacotes) {
    const url = new URL(caminho, RAIZ);
    const texto = readFileSync(url, 'utf8');
    const atual = JSON.parse(texto).version;
    if (atual === versao) continue;
    if (checando) {
      pendencias.push(`${caminho}: version ${atual}, ${linha.notas} diz ${versao}`);
      continue;
    }
    // Substituição na LINHA, e não `JSON.stringify` do objeto inteiro: reescrever
    // o `package.json` todo mudaria indentação e ordem de chaves, e o diff da
    // entrega deixaria de mostrar só a versão.
    const novo = texto.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${versao}"`);
    if (novo === texto) falharGeral(`não achei o campo version em ${caminho}`);
    writeFileSync(url, novo);
    console.log(`release: ${caminho} → ${versao}`);
  }

  const alvo = changelog(linha, releases);
  const destino = new URL(linha.changelog, RAIZ);
  let atual = '';
  try {
    atual = readFileSync(destino, 'utf8');
  } catch {
    atual = '';
  }

  if (atual !== alvo) {
    if (checando) {
      pendencias.push(`${linha.changelog} está fora de sincronia com ${linha.notas}`);
    } else {
      writeFileSync(destino, alvo);
      console.log(`release: ${linha.changelog} → ${releases.length} entrada(s)`);
    }
  }
}

if (checando) {
  if (pendencias.length) {
    for (const p of pendencias) console.error(`release: ${p}`);
    console.error('release: rode `pnpm release` e commite o resultado.');
    exit(1);
  }
  console.log(`release: tudo em sincronia — ${prontas.join(', ')}.`);
} else {
  console.log(`release: ${prontas.join(', ')} — pronto.`);
}
