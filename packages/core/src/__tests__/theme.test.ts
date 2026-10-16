import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME_ID, findTheme, isLightTheme, THEMES } from '../themes.js';
import { themeCssVars, themeResolvedColors } from '../theme/tokens.js';
import { mixOklab } from '../theme/oklab.js';

describe('themes', () => {
  it('traz os 9 esquemas com 8 cores ANSI cada', () => {
    expect(THEMES).toHaveLength(9);
    for (const t of THEMES) {
      expect(t.ansi).toHaveLength(8);
      for (const c of [t.bg, t.fg, t.accent, ...t.ansi]) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('cai no tema padrão para ids desconhecidos', () => {
    expect(findTheme('nao-existe').id).toBe(DEFAULT_THEME_ID);
    expect(findTheme(null).id).toBe(DEFAULT_THEME_ID);
    expect(findTheme('nord').id).toBe('nord');
  });

  it('marca github-light como o único tema claro', () => {
    expect(THEMES.filter((t) => isLightTheme(t.id))).toHaveLength(1);
    expect(isLightTheme('github-light')).toBe(true);
  });
});

describe('themeCssVars', () => {
  const vars = themeCssVars(findTheme('catppuccin-mocha'));

  it('expõe bg, fg e accent sem derivação', () => {
    expect(vars['--color-bg']).toBe('#1e1e2e');
    expect(vars['--color-text']).toBe('#cdd6f4');
    expect(vars['--color-accent']).toBe('#cba6f7');
  });

  it('deriva as escalas com color-mix em oklab, nas porcentagens do handoff', () => {
    expect(vars['--color-surface']).toBe('color-mix(in oklab, #cdd6f4 6%, #1e1e2e)');
    expect(vars['--color-neutral-500']).toBe('color-mix(in oklab, #cdd6f4 57%, #1e1e2e)');
    expect(vars['--color-neutral-900']).toBe('color-mix(in oklab, #cdd6f4 9%, #1e1e2e)');
    // accent 100–400 mistura com fg; 600–900 com bg
    expect(vars['--color-accent-100']).toBe('color-mix(in oklab, #cba6f7 25%, #cdd6f4)');
    expect(vars['--color-accent-500']).toBe('color-mix(in oklab, #cba6f7 100%, #1e1e2e)');
    expect(vars['--color-accent-900']).toBe('color-mix(in oklab, #cba6f7 18%, #1e1e2e)');
  });

  it('gera o conjunto completo de tokens para todos os temas', () => {
    for (const t of THEMES) {
      const v = themeCssVars(t);
      for (const n of [100, 200, 300, 400, 500, 600, 700, 800, 900]) {
        expect(v['--color-neutral-' + n]).toBeTruthy();
        expect(v['--color-accent-' + n]).toBeTruthy();
      }
      for (let i = 0; i < 8; i++) expect(v['--ansi-' + i]).toBe(t.ansi[i]);
      expect(v['--shadow-lg']).toContain('0 16px 40px');
    }
  });
});

describe('mixOklab', () => {
  it('nos extremos devolve cada cor intacta', () => {
    expect(mixOklab('#ffffff', 100, '#000000')).toBe('#ffffff');
    expect(mixOklab('#ffffff', 0, '#000000')).toBe('#000000');
  });

  it('é monotônico e fica entre as duas cores', () => {
    const steps = [0, 25, 50, 75, 100].map((p) => mixOklab('#ffffff', p, '#000000'));
    const lum = steps.map((hex) => parseInt(hex.slice(1, 3), 16));
    for (let i = 1; i < lum.length; i++) expect(lum[i]!).toBeGreaterThan(lum[i - 1]!);
  });

  it('reproduz em hex as mesmas misturas que o CSS faria', () => {
    const resolved = themeResolvedColors(findTheme('nord'));
    expect(resolved['bg']).toBe('#2e3440');
    expect(resolved['accent-500']).toBe('#88c0d0');
    expect(resolved['neutral-100']).toBe('#d8dee9');
    expect(resolved['surface']).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('rejeita cor inválida', () => {
    expect(() => mixOklab('roxo', 50, '#000000')).toThrow(/hex inválida/);
  });
});
