/**
 * Gera as telas de abertura do iOS (`apple-touch-startup-image`) a partir do
 * `splash.svg` do handoff de marca.
 *
 * Por que um navegador e não o `sharp`: o SVG tem texto em JetBrains Mono, e
 * rasterizador fora do navegador depende da fonte estar instalada no sistema —
 * se não estiver, a tipografia troca silenciosamente. Aqui a fonte vem do
 * `@fontsource` que o próprio app usa, embutida na página, então o resultado é
 * o mesmo em qualquer máquina. É também o que o `pwa-asset-generator` faz por
 * dentro, sem trazer outra dependência.
 *
 * Saída committada (como os ícones): rode só quando a marca mudar.
 *   node scripts/gen-splash.mjs
 */
import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const SRC = join(here, '..', '..', '..', 'design_handoff_ondas_brand_assets', 'assets', 'splash.svg');
const OUT = join(here, '..', 'public', 'splash');
const BG = '#1e1e2e';

/**
 * Telas em retrato (o manifest fixa `orientation: portrait`). `w`/`h` são
 * pixels; `dw`/`dh`/`dpr` são o que entra na media query do iOS.
 */
const SIZES = [
  { dw: 375, dh: 667, dpr: 2 }, // iPhone SE 2ª/3ª, 8
  { dw: 375, dh: 812, dpr: 3 }, // iPhone X, XS, 11 Pro
  { dw: 390, dh: 844, dpr: 3 }, // iPhone 12, 13, 14
  { dw: 393, dh: 852, dpr: 3 }, // iPhone 14 Pro, 15, 16
  { dw: 402, dh: 874, dpr: 3 }, // iPhone 16 Pro
  { dw: 414, dh: 896, dpr: 2 }, // iPhone XR, 11
  { dw: 414, dh: 896, dpr: 3 }, // iPhone XS Max, 11 Pro Max
  { dw: 428, dh: 926, dpr: 3 }, // iPhone 12/13 Pro Max, 14 Plus
  { dw: 430, dh: 932, dpr: 3 }, // iPhone 14/15 Pro Max, 16 Plus
  { dw: 440, dh: 956, dpr: 3 }, // iPhone 16 Pro Max
  { dw: 360, dh: 780, dpr: 3 }, // iPhone 12/13 mini
  { dw: 744, dh: 1133, dpr: 2 }, // iPad mini 6
  { dw: 768, dh: 1024, dpr: 2 }, // iPad 9.7"
  { dw: 810, dh: 1080, dpr: 2 }, // iPad 10.2"
  { dw: 820, dh: 1180, dpr: 2 }, // iPad Air 10.9"
  { dw: 834, dh: 1112, dpr: 2 }, // iPad Pro 10.5"
  { dw: 834, dh: 1194, dpr: 2 }, // iPad Pro 11"
  { dw: 1024, dh: 1366, dpr: 2 }, // iPad Pro 12.9"
].map((d) => ({ ...d, w: d.dw * d.dpr, h: d.dh * d.dpr }));

const fontFace = async (weight, file) => {
  const data = await readFile(require.resolve(`@fontsource/jetbrains-mono/files/${file}`));
  return `@font-face{font-family:'JetBrains Mono';font-weight:${weight};font-style:normal;src:url(data:font/woff2;base64,${data.toString('base64')}) format('woff2')}`;
};

// O C2PA do arquivo original é metadado de proveniência: não precisa ir ao DOM.
const svg = (await readFile(SRC, 'utf8')).replace(/<metadata>[\s\S]*?<\/metadata>/g, '');
const fonts = [await fontFace(400, 'jetbrains-mono-latin-400-normal.woff2'), await fontFace(500, 'jetbrains-mono-latin-500-normal.woff2')].join('');

const page = (w, h) => `<!doctype html><meta charset="utf-8"><style>
${fonts}
html,body{margin:0;width:100%;height:100%;background:${BG};overflow:hidden}
body{display:flex;align-items:center;justify-content:center}
/* O preserveAspectRatio padrão do SVG (xMidYMid meet) já centraliza e cabe
   dentro da caixa — é o mesmo efeito do --background do pwa-asset-generator. */
svg{width:${w}px;height:${h}px;display:block}
</style>${svg}`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();

for (const { w, h, dpr } of SIZES) {
  const file = join(OUT, `splash-${w}x${h}.png`);
  const ctx = await browser.newContext({
    viewport: { width: w / dpr, height: h / dpr },
    deviceScaleFactor: dpr,
  });
  const p = await ctx.newPage();
  await p.setContent(page(w / dpr, h / dpr), { waitUntil: 'load' });
  await p.evaluate(() => document.fonts.ready);
  await writeFile(file, await p.screenshot({ type: 'png' }));
  await ctx.close();
  console.log(`splash: splash-${w}x${h}.png`);
}

await browser.close();

// As tags do <head> saem daqui para não divergirem da lista acima.
console.log('\n<!-- cole no index.html -->');
for (const { w, h, dw, dh, dpr } of SIZES) {
  console.log(
    `<link rel="apple-touch-startup-image" media="screen and (device-width: ${dw}px) and ` +
      `(device-height: ${dh}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)" ` +
      `href="/splash/splash-${w}x${h}.png" />`,
  );
}
