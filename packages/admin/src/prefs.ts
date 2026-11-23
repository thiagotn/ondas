import {
  definirIdioma,
  findTheme,
  isLightTheme,
  isThemeId,
  LOCALES,
  themeCssVars,
  type Locale,
  type ThemeId,
} from '@ondas/core';

/**
 * Tema e idioma do painel — os mesmos da PWA, guardados NESTE navegador.
 *
 * Na PWA quem manda nas duas preferências é a conta. Aqui não há conta: quem
 * entra é o token de admin, que não tem identidade. E o `localStorage` da PWA
 * é de outra origem (`music.` × `ondas-admin.`), então não há o que herdar.
 * As duas escolhas moram em chaves próprias e valem só para este navegador.
 */

const CHAVE_TEMA = 'ondas-admin:tema';
const CHAVE_IDIOMA = 'ondas-admin:idioma';

function ler(chave: string): string | null {
  try {
    return localStorage.getItem(chave);
  } catch {
    // Modo privado, armazenamento bloqueado: vale o padrão.
    return null;
  }
}

function guardar(chave: string, valor: string): void {
  try {
    localStorage.setItem(chave, valor);
  } catch {
    // Sem onde guardar, a escolha vale só até recarregar.
  }
}

export function temaAtual(): ThemeId {
  return findTheme(ler(CHAVE_TEMA)).id;
}

/**
 * Escreve os tokens do tema em `:root` — os mesmos de `applyTheme` na PWA,
 * sem a opacidade: aqui não há wallpaper por baixo.
 */
export function aplicarTema(id: string): void {
  const tema = findTheme(id);
  const raiz = document.documentElement;
  for (const [chave, valor] of Object.entries(themeCssVars(tema))) {
    raiz.style.setProperty(chave, valor);
  }
  raiz.style.colorScheme = isLightTheme(tema.id) ? 'light' : 'dark';
  raiz.dataset['theme'] = tema.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', tema.bg);
}

/** Troca na hora: tema é só cor, não há frase montada em estado para refazer. */
export function trocarTema(id: string): void {
  if (!isThemeId(id)) return;
  guardar(CHAVE_TEMA, id);
  aplicarTema(id);
}

/** O idioma do navegador, quando é um dos três. `pt` casa `pt-BR`. */
function doNavegador(): Locale | null {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (base === 'pt') return 'pt-BR';
    const achado = LOCALES.find((l) => l.toLowerCase().split('-')[0] === base);
    if (achado) return achado;
  }
  return null;
}

/**
 * Decide tema e idioma e os fixa. Roda UMA vez, antes de desenhar.
 *
 * A ordem do idioma é a da PWA sem o endereço: a escolha guardada, o
 * navegador, e pt-BR de reserva. Não há prefixo `/en` aqui — o painel não tem
 * link compartilhado nem prévia para preservar.
 */
export function iniciarPrefs(): void {
  aplicarTema(temaAtual());
  const salvo = ler(CHAVE_IDIOMA);
  const locale = LOCALES.find((l) => l === salvo) ?? doNavegador() ?? 'pt-BR';
  definirIdioma(locale);
  document.documentElement.lang = locale;
}

/**
 * Troca de idioma RECARREGANDO, pelo mesmo motivo da PWA: o idioma é de módulo
 * no core, e metade das frases já está montada em estado — um re-render
 * deixaria a tela meio traduzida. A sessão é cookie e sobrevive; o que se
 * perde é o que estava digitado e não salvo, e trocar de idioma é gesto raro.
 */
export function trocarIdioma(locale: Locale): void {
  guardar(CHAVE_IDIOMA, locale);
  location.reload();
}
