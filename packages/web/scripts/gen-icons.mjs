/**
 * Gera os ícones da PWA a partir do logo ASCII do handoff.
 * Idempotente: não regrava se os PNGs já existem e são mais novos que este script.
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'icons');

const BG = '#1e1e2e';
const ACCENT = '#cba6f7';

/** O mesmo logo de 3 linhas da tela de login, em caixa de desenho. */
const LOGO = ['┌─┐┌┐┌┌┬┐┌─┐┌─┐', '│ ││││ ││├─┤└─┐', '└─┘┘└┘─┴┘┴ ┴└─┘'];

function svg({ size, padding }) {
  const fontSize = (size - padding * 2) / 9.6;
  const lineHeight = fontSize * 1.2;
  const firstY = size / 2 - lineHeight + fontSize * 0.36;
  const lines = LOGO.map(
    (l, i) =>
      `<text x="50%" y="${firstY + i * lineHeight}" text-anchor="middle" ` +
      `font-family="JetBrains Mono, DejaVu Sans Mono, monospace" font-size="${fontSize}" ` +
      `fill="${ACCENT}" xml:space="preserve">${l}</text>`,
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${BG}"/>${lines}
</svg>`;
}

const targets = [
  { file: 'icon-192.png', size: 192, padding: 16 },
  { file: 'icon-512.png', size: 512, padding: 42 },
  { file: 'apple-touch-icon.png', size: 180, padding: 14 },
  // Maskable: área segura de 80% — o logo recua para não ser cortado.
  { file: 'maskable-192.png', size: 192, padding: 38 },
  { file: 'maskable-512.png', size: 512, padding: 102 },
];

await mkdir(outDir, { recursive: true });
const scriptMtime = (await stat(fileURLToPath(import.meta.url))).mtimeMs;

for (const t of targets) {
  const out = join(outDir, t.file);
  const existing = await stat(out).catch(() => null);
  if (existing && existing.mtimeMs > scriptMtime) continue;
  const png = await sharp(Buffer.from(svg(t))).png({ compressionLevel: 9 }).toBuffer();
  await writeFile(out, png);
  console.log('icons: ' + t.file + ' (' + t.size + 'px)');
}

// Favicon vetorial, para a aba do navegador.
await writeFile(join(outDir, 'icon.svg'), svg({ size: 512, padding: 42 }));
