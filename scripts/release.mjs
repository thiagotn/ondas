#!/usr/bin/env node
/**
 * `pnpm release` — a versão e o CHANGELOG saem da nota, não da mão.
 *
 * A fonte única é `packages/core/src/release/notas.json` (o formato está
 * explicado em `packages/core/src/release/index.ts`). Daqui saem os dois
 * destinos que o JSON não alcança sozinho:
 *
 *   1. o campo `version` dos três `package.json` (raiz, core, web) — é dele que
 *      o Vite monta `__APP_VERSION__`, a versão que `ondas --about` e a tela de
 *      login mostram;
 *   2. o `CHANGELOG.md` da raiz, para quem lê o repositório e não o app.
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
const NOTAS = new URL('packages/core/src/release/notas.json', RAIZ);
const CHANGELOG = new URL('CHANGELOG.md', RAIZ);
const PACOTES = ['package.json', 'packages/core/package.json', 'packages/web/package.json'];

const SEMVER = /^\d+\.\d+\.\d+$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const IDIOMAS = ['pt-BR', 'en', 'es'];

const checando = argv.includes('--check');

const releases = JSON.parse(readFileSync(NOTAS, 'utf8'));
validar(releases);
const versao = releases[0].versao;

/**
 * O que um JSON mal escrito faria sem isto: um `CHANGELOG` com `undefined` no
 * meio, ou uma versão que não é versão escrita nos três pacotes. Barato de
 * conferir, caro de descobrir depois.
 */
function validar(lista) {
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

function falhar(msg) {
  console.error(`release: ${msg}`);
  exit(1);
}

/** O arquivo que o repositório deveria ter, dado o JSON de agora. */
function changelog() {
  const linhas = [
    '# Changelog',
    '',
    'Todas as entregas do ondas, da mais nova para a mais velha.',
    '',
    '**Este arquivo é gerado.** A nota se escreve em',
    '`packages/core/src/release/notas.json` e sai daqui por `pnpm release` — a mesma lista é a',
    'página `/changelog` do app, nos três idiomas. Editar este arquivo à mão é trabalho que o',
    'próximo `pnpm release` desfaz.',
    '',
  ];
  for (const r of releases) {
    linhas.push(`## ${r.versao} — ${r.data}`, '');
    for (const item of r.itens) linhas.push(`- ${item['pt-BR']}`);
    linhas.push('');
  }
  return linhas.join('\n');
}

const alvo = changelog();
const pendencias = [];

for (const caminho of PACOTES) {
  const url = new URL(caminho, RAIZ);
  const texto = readFileSync(url, 'utf8');
  const atual = JSON.parse(texto).version;
  if (atual === versao) continue;
  if (checando) {
    pendencias.push(`${caminho}: version ${atual}, notas.json diz ${versao}`);
    continue;
  }
  // Substituição na LINHA, e não `JSON.stringify` do objeto inteiro: reescrever
  // o `package.json` todo mudaria indentação e ordem de chaves, e o diff da
  // entrega deixaria de mostrar só a versão.
  const novo = texto.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${versao}"`);
  if (novo === texto) falhar(`não achei o campo version em ${caminho}`);
  writeFileSync(url, novo);
  console.log(`release: ${caminho} → ${versao}`);
}

let changelogAtual = '';
try {
  changelogAtual = readFileSync(CHANGELOG, 'utf8');
} catch {
  changelogAtual = '';
}

if (changelogAtual !== alvo) {
  if (checando) {
    pendencias.push('CHANGELOG.md está fora de sincronia com notas.json');
  } else {
    writeFileSync(CHANGELOG, alvo);
    console.log(`release: CHANGELOG.md → ${releases.length} entrada(s)`);
  }
}

if (checando) {
  if (pendencias.length) {
    for (const p of pendencias) console.error(`release: ${p}`);
    console.error('release: rode `pnpm release` e commite o resultado.');
    exit(1);
  }
  console.log(`release: tudo em sincronia na ${versao}.`);
} else {
  console.log(`release: ${versao} pronta.`);
}
