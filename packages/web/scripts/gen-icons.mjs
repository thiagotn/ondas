/**
 * Gera os ícones do sistema (favicon, ícone instalado, apple-touch) a partir
 * dos SVGs do handoff de marca.
 *
 * No navegador, como o `gen-splash.mjs` e pelo mesmo motivo de fundo: o que
 * rasteriza aqui é o mesmo motor que vai desenhar o logo dentro do app, então o
 * ícone instalado e a marca na tela não divergem por diferença de renderizador.
 *
 * Os PNGs do sistema têm cor FIXA (a do tema padrão, Catppuccin Mocha): o
 * sistema operacional não conhece o tema que a pessoa escolheu.
 *
 * Saída committada: rode só quando a marca mudar.
 *   node scripts/gen-icons.mjs
 */
import { chromium } from '@playwright/test';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', '..', '..', 'design_handoff_ondas_brand_onda', 'assets');
const PUBLIC = join(here, '..', 'public');
const OUT = join(PUBLIC, 'icons');

/**
 * Cada PNG, de qual SVG sai e em que tamanho.
 *
 * Os dois favicons saem do `favicon.svg`, que usa a versão simplificada da
 * marca (sem estrias nem dedos de espuma): em 16px o detalhe vira ruído.
 * O apple-touch sai de um SVG sem cantos arredondados e sem transparência — o
 * iOS arredonda por conta própria e pinta de preto o que vier transparente.
 */
const ICONS = [
  { file: 'favicon-16.png', src: 'favicon.svg', size: 16 },
  { file: 'favicon-32.png', src: 'favicon.svg', size: 32 },
  { file: 'apple-touch-icon-180.png', src: 'icon-apple.svg', size: 180 },
  { file: 'icon-192.png', src: 'icon.svg', size: 192 },
  { file: 'icon-512.png', src: 'icon.svg', size: 512 },
  { file: 'icon-maskable-512.png', src: 'icon-maskable.svg', size: 512 },
];

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();

for (const { file, src, size } of ICONS) {
  const svg = await readFile(join(SRC, src), 'utf8');
  const ctx = await browser.newContext({ viewport: { width: size, height: size } });
  const p = await ctx.newPage();
  await p.setContent(
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    { waitUntil: 'load' },
  );
  // `omitBackground`: os cantos arredondados do ícone têm de sair transparentes.
  await writeFile(join(OUT, file), await p.screenshot({ type: 'png', omitBackground: true }));
  await ctx.close();
  console.log(`icons: ${file}`);
}

await browser.close();

// O favicon vetorial é o próprio SVG do handoff, sem passar por rasterização.
await copyFile(join(SRC, 'favicon.svg'), join(PUBLIC, 'favicon.svg'));
console.log('icons: favicon.svg');
