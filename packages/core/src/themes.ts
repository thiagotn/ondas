import type { ThemeDef, ThemeId } from './types.js';

/**
 * Os 9 esquemas de cor. Cada tema define apenas bg, fg, accent e os 8 ANSI;
 * todo o resto é derivado em `theme/tokens.ts`.
 */
export const THEMES: readonly ThemeDef[] = [
  { id: 'nocturne', name: 'Nocturne', bg: '#161826', fg: '#e9e9ed', accent: '#9184d9',
    ansi: ['#292b31', '#d98484', '#84d9a0', '#d9c784', '#84a6d9', '#9184d9', '#84d0d9', '#cfd3e5'] },
  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', bg: '#1e1e2e', fg: '#cdd6f4', accent: '#cba6f7',
    ansi: ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de'] },
  { id: 'tokyonight', name: 'TokyoNight', bg: '#1a1b26', fg: '#c0caf5', accent: '#7aa2f7',
    ansi: ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6'] },
  { id: 'dracula', name: 'Dracula', bg: '#282a36', fg: '#f8f8f2', accent: '#bd93f9',
    ansi: ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2'] },
  { id: 'gruvbox-dark', name: 'Gruvbox Dark', bg: '#282828', fg: '#ebdbb2', accent: '#fabd2f',
    ansi: ['#3c3836', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#a89984'] },
  { id: 'nord', name: 'Nord', bg: '#2e3440', fg: '#d8dee9', accent: '#88c0d0',
    ansi: ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0'] },
  { id: 'rose-pine', name: 'Rosé Pine', bg: '#191724', fg: '#e0def4', accent: '#ebbcba',
    ansi: ['#26233a', '#eb6f92', '#9ccfd8', '#f6c177', '#31748f', '#c4a7e7', '#ebbcba', '#e0def4'] },
  { id: 'solarized-dark', name: 'Solarized Dark', bg: '#002b36', fg: '#93a1a1', accent: '#268bd2',
    ansi: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5'] },
  { id: 'github-light', name: 'GitHub Light', bg: '#ffffff', fg: '#24292f', accent: '#0969da',
    ansi: ['#24292f', '#cf222e', '#116329', '#9a6700', '#0969da', '#8250df', '#1b7c83', '#6e7781'] },
] as const;

export const DEFAULT_THEME_ID: ThemeId = 'catppuccin-mocha';

export function findTheme(id: string | null | undefined): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME_ID)!;
}

export function themeIndex(id: string | null | undefined): number {
  return Math.max(0, THEMES.findIndex((t) => t.id === findTheme(id).id));
}

/** Único tema claro: define `color-scheme` e o esquema dos controles nativos. */
export function isLightTheme(id: string | null | undefined): boolean {
  return findTheme(id).id === 'github-light';
}
