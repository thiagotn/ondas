import type { ThemeDef } from '../types.js';
import { mixOklab } from './oklab.js';

/**
 * Escalas derivadas (porta fiel do `applyTheme()` do protótipo).
 * Cada entrada é [sufixo do token, porcentagem].
 */
const NEUTRAL: readonly (readonly [number, number])[] = [
  [100, 100], [200, 92], [300, 82], [400, 70], [500, 57], [600, 44], [700, 30], [800, 18], [900, 9],
];

/** Accent 100–400 mistura com `fg`; 500 é o accent puro; 600–900 mistura com `bg`. */
const ACCENT: readonly (readonly [number, number, 'fg' | 'bg'])[] = [
  [100, 25, 'fg'], [200, 45, 'fg'], [300, 65, 'fg'], [400, 85, 'fg'],
  [500, 100, 'bg'], [600, 78, 'bg'], [700, 55, 'bg'], [800, 35, 'bg'], [900, 18, 'bg'],
];

const FONT_STACK = '"JetBrains Mono", ui-monospace, monospace';

const cssMix = (a: string, p: number, b: string) => `color-mix(in oklab, ${a} ${p}%, ${b})`;

/**
 * Tokens CSS de um tema, prontos para `documentElement.style.setProperty`.
 * Os valores usam `color-mix(in oklab, …)` para bater exatamente com o protótipo.
 */
export function themeCssVars(theme: ThemeDef): Record<string, string> {
  const { bg, fg, accent, ansi } = theme;
  const vars: Record<string, string> = {
    '--color-bg': bg,
    '--color-text': fg,
    '--color-surface': cssMix(fg, 6, bg),
    '--color-accent': accent,
    '--color-divider': cssMix(fg, 16, 'transparent'),
    '--font-body': FONT_STACK,
    '--font-heading': FONT_STACK,
    '--radius-sm': '4px',
    '--radius-md': '8px',
    '--radius-lg': '14px',
    '--shadow-sm': `0 0 0 1px ${cssMix(fg, 18, bg)}`,
    '--shadow-md': `0 0 0 1px ${cssMix(fg, 30, bg)}, 0 6px 18px rgba(0,0,0,.35)`,
    '--shadow-lg': `0 0 0 1px ${cssMix(fg, 44, bg)}, 0 16px 40px rgba(0,0,0,.45)`,
  };
  for (const [k, p] of NEUTRAL) vars['--color-neutral-' + k] = cssMix(fg, p, bg);
  for (const [k, p, over] of ACCENT) vars['--color-accent-' + k] = cssMix(accent, p, over === 'fg' ? fg : bg);
  ansi.forEach((c, i) => (vars['--ansi-' + i] = c));
  return vars;
}

/**
 * As mesmas cores, já resolvidas em hex (via OKLab). Para o `theme-color` da PWA,
 * o manifest e o theme provider nativo, que não entendem `color-mix()`.
 */
export function themeResolvedColors(theme: ThemeDef): Record<string, string> {
  const { bg, fg, accent, ansi } = theme;
  const out: Record<string, string> = {
    bg,
    text: fg,
    surface: mixOklab(fg, 6, bg),
    accent,
  };
  for (const [k, p] of NEUTRAL) out['neutral-' + k] = mixOklab(fg, p, bg);
  for (const [k, p, over] of ACCENT) out['accent-' + k] = mixOklab(accent, p, over === 'fg' ? fg : bg);
  ansi.forEach((c, i) => (out['ansi-' + i] = c));
  return out;
}
