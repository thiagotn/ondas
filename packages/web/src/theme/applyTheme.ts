import { findTheme, isLightTheme, themeCssVars, type ThemeId } from '@ondas/core';

export const THEME_STORAGE_KEY = 'ondas-theme';

/**
 * Escreve os tokens do tema em `:root`. O `<meta name="theme-color">` e o
 * `color-scheme` acompanham, para a barra do sistema e os controles nativos
 * combinarem com o esquema atual.
 */
export function applyTheme(id: ThemeId | string): void {
  const theme = findTheme(id);
  const root = document.documentElement;
  for (const [key, value] of Object.entries(themeCssVars(theme))) {
    root.style.setProperty(key, value);
  }
  root.style.colorScheme = isLightTheme(theme.id) ? 'light' : 'dark';
  root.dataset['theme'] = theme.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.bg);
}

/**
 * O tema é lido de forma sincrônica (antes do primeiro paint, pelo script do
 * `index.html`), então fica no localStorage — e não no IndexedDB.
 */
export function readStoredTheme(): ThemeId {
  try {
    return findTheme(localStorage.getItem(THEME_STORAGE_KEY)).id;
  } catch {
    return findTheme(null).id;
  }
}

export function storeTheme(id: ThemeId): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    // Modo privado: o tema vale só para esta sessão.
  }
}
