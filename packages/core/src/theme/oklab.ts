/**
 * Mistura de cores em OKLab — a mesma operação que `color-mix(in oklab, a p%, b)`
 * faz no CSS, mas resolvida em JS.
 *
 * A web usa as strings `color-mix()` (ver `tokens.ts`), que são idênticas e mais
 * baratas. Esta implementação existe para onde é preciso um valor concreto:
 * `<meta name="theme-color">`, o manifest da PWA e o theme provider nativo da fase 2.
 */

type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error('cor hex inválida: ' + hex);
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function rgbToHex([r, g, b]: RGB): string {
  const ch = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return '#' + ch(r) + ch(g) + ch(b);
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toGamma = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** sRGB (0..1) → OKLab, conforme Björn Ottosson. */
function linearToOklab([r, g, b]: RGB): RGB {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

function oklabToLinear([L, a, b]: RGB): RGB {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/**
 * `mixOklab('#fff', 18, '#000')` = 18% da primeira cor, 82% da segunda —
 * mesma semântica de `color-mix(in oklab, #fff 18%, #000)`.
 */
export function mixOklab(a: string, pct: number, b: string): string {
  const w = Math.min(100, Math.max(0, pct)) / 100;
  const A = linearToOklab(hexToRgb(a).map(toLinear) as RGB);
  const B = linearToOklab(hexToRgb(b).map(toLinear) as RGB);
  const mixed = A.map((v, i) => v * w + B[i]! * (1 - w)) as RGB;
  return rgbToHex(oklabToLinear(mixed).map(toGamma) as RGB);
}
