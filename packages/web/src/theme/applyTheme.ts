import { findTheme, isLightTheme, isThemeId, themeCssVars, type ThemeId } from '@ondas/core';

export const THEME_STORAGE_KEY = 'ondas-theme';

/**
 * Escreve os tokens do tema em `:root`. O `<meta name="theme-color">` e o
 * `color-scheme` acompanham, para a barra do sistema e os controles nativos
 * combinarem com o esquema atual.
 *
 * A opacidade é parâmetro obrigatório de propósito: ela entra nos tokens `-a`,
 * e esquecê-la em qualquer chamada (inclusive na pré-visualização do picker)
 * devolveria o app ao opaco sem aviso. O compilador cobra.
 */
export function applyTheme(id: ThemeId | string, opacity: number): void {
  const theme = findTheme(id);
  const root = document.documentElement;
  for (const [key, value] of Object.entries(themeCssVars(theme, opacity))) {
    root.style.setProperty(key, value);
  }
  root.style.colorScheme = isLightTheme(theme.id) ? 'light' : 'dark';
  root.dataset['theme'] = theme.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.bg);
}

/**
 * O tema é lido de forma sincrônica (antes do primeiro paint, pelo script do
 * `index.html`), então fica no localStorage — e não no IndexedDB.
 *
 * Com conta, este valor é ESPELHO: a dona é a conta, e `app/prefs.ts` o regrava
 * quando ela diz outra coisa. Continua aqui porque só o localStorage dá para
 * ler antes do primeiro paint.
 */
export function readStoredTheme(): ThemeId {
  try {
    return findTheme(localStorage.getItem(THEME_STORAGE_KEY)).id;
  } catch {
    return findTheme(null).id;
  }
}

/**
 * O tema que alguém ESCOLHEU neste aparelho, ou `null` se ninguém escolheu.
 *
 * `readStoredTheme` não serve para essa pergunta: ele devolve o padrão quando
 * não há nada guardado, e "está no padrão" não é "escolheu o padrão". A
 * diferença decide se este aparelho tem o que entregar à conta na primeira vez
 * (ver `decidirPrefs`).
 */
export function temaSalvo(): ThemeId | null {
  try {
    const id = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeId(id) ? id : null;
  } catch {
    return null;
  }
}

export function storeTheme(id: ThemeId): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    // Modo privado: o tema vale só para esta sessão.
  }
}
