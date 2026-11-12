import { LOCALES, type Locale } from './i18n/motor.js';
import { BLUR_MAX, OPACITY_MAX, OPACITY_MIN } from './stores/ui.js';
import { isThemeId } from './themes.js';
import type { ThemeId, WallMode } from './types.js';

/**
 * A aparência que segue a conta: tema, idioma e os ajustes do fundo.
 *
 * Todo campo é opcional, e AUSENTE tem sentido: "a conta nunca escolheu". É o
 * que separa uma conta que quer o tema padrão de uma que ainda não disse nada
 * — e só a segunda adota o que o aparelho já tinha (ver `decidirPrefs`).
 *
 * A IMAGEM de fundo não está aqui, e não é esquecimento: ela é um arquivo de
 * até ~1 MB e fica no aparelho que a escolheu. O que viaja é `wall`, o modo —
 * `imagem` inclusive, mesmo para um aparelho que não tem imagem nenhuma (ver
 * `wallEfetivo`).
 *
 * Os nomes são os de `BackgroundSettings` de propósito: não há mapeamento
 * entre o que o store guarda e o que a API recebe.
 */
export interface PrefsDaConta {
  tema?: ThemeId;
  idioma?: Locale;
  opacity?: number;
  blur?: number;
  wall?: WallMode;
}

export const CAMPOS_DE_PREFS = ['tema', 'idioma', 'opacity', 'blur', 'wall'] as const;

const WALLS: readonly WallMode[] = ['capa', 'imagem', 'nenhum'];

/**
 * A peneira do que vem de FORA — do servidor, do espelho no IndexedDB, de uma
 * fila gravada por outra versão.
 *
 * Campo desconhecido é DESCARTADO, e não trocado por um padrão: um tema que
 * este build não tem (a conta o escolheu num aparelho com versão mais nova)
 * tem de significar "não sei", e não "catppuccin". `findTheme` cai no padrão,
 * e por isso ele não serve aqui — aplicaria o tema errado e, pior, o subiria de
 * volta por cima do certo.
 *
 * Os números são arredondados como os sliders os produzem (opacidade em
 * centésimos, desfoque inteiro). Sem isso `0.55` de um lado e
 * `0.5499999999999999` do outro seriam uma diferença eterna entre o aparelho e
 * a conta.
 */
export function lePrefs(bruto: unknown): PrefsDaConta {
  if (!bruto || typeof bruto !== 'object') return {};
  const b = bruto as Record<string, unknown>;
  const prefs: PrefsDaConta = {};
  if (typeof b['tema'] === 'string' && isThemeId(b['tema'])) prefs.tema = b['tema'];
  const idioma = LOCALES.find((l) => l === b['idioma']);
  if (idioma) prefs.idioma = idioma;
  if (typeof b['opacity'] === 'number' && Number.isFinite(b['opacity'])) {
    prefs.opacity = Math.round(limitar(b['opacity'], OPACITY_MIN, OPACITY_MAX) * 100) / 100;
  }
  if (typeof b['blur'] === 'number' && Number.isFinite(b['blur'])) {
    prefs.blur = limitar(Math.round(b['blur']), 0, BLUR_MAX);
  }
  const wall = WALLS.find((w) => w === b['wall']);
  if (wall) prefs.wall = wall;
  return prefs;
}

const limitar = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * O fundo que a tela MOSTRA.
 *
 * `imagem` sem imagem neste aparelho é exibido como `capa`: a imagem não
 * viaja, então a conta pode pedir um modo que este aparelho não tem como
 * cumprir. A preferência continua `imagem` — trocá-la aqui subiria `capa` para
 * a conta e desfaria a escolha no aparelho que TEM a imagem.
 */
export function wallEfetivo(wall: WallMode, wallImg: string): WallMode {
  return wall === 'imagem' && !wallImg ? 'capa' : wall;
}

/**
 * Quem vence, campo a campo, entre a conta e o aparelho.
 *
 * Roda quando a sessão chega (boot e login). Devolve o que SOBE para a conta e
 * o que se APLICA neste aparelho — nunca as duas coisas para o mesmo campo.
 *
 *   - `conta` indefinida: o servidor (ou o espelho) é de antes das
 *     preferências. Não se aplica nem se sobe nada — um servidor antigo
 *     recusaria o campo que não conhece, e o aparelho segue só local, como era.
 *   - o campo está em `pendente`: foi mudado AQUI, com sessão, e ainda não
 *     chegou ao servidor (faltou rede). Esse gesto vence a conta, e sobe.
 *   - a conta tem o campo: ela vence. É a regra que faz o segundo aparelho
 *     abrir como o primeiro.
 *   - a conta não tem, o aparelho tem uma escolha explícita, e este aparelho
 *     nunca adotou: sobe a do aparelho. É o dia da atualização — quem já tinha
 *     um tema não o perde para um padrão que ninguém escolheu.
 *
 * `adotado` é por APARELHO e nunca volta a `false`, nem no logout: sem ele, o
 * tema de quem saiu seria adotado pela próxima conta que entrasse neste
 * navegador, e escrito nela.
 *
 * Sem relógio, ao contrário do marcador: o conflito aqui é por campo, e o
 * único caso que um timestamp resolveria — duas mudanças do MESMO campo, uma
 * delas offline por dias — custa um gesto para desfazer. Não paga uma tabela.
 */
export function decidirPrefs(e: {
  conta: PrefsDaConta | undefined;
  /** Só o que foi ESCOLHIDO neste aparelho — padrão em vigor não conta. */
  local: PrefsDaConta;
  pendente: PrefsDaConta;
  adotado: boolean;
}): { subir: PrefsDaConta; aplicar: PrefsDaConta } {
  const subir: Record<string, unknown> = {};
  const aplicar: Record<string, unknown> = {};
  if (!e.conta) return { subir: {}, aplicar: {} };

  const conta = lePrefs(e.conta);
  const local = lePrefs(e.local);
  const pendente = lePrefs(e.pendente);
  for (const k of CAMPOS_DE_PREFS) {
    if (pendente[k] !== undefined) subir[k] = pendente[k];
    else if (conta[k] !== undefined) {
      if (conta[k] !== local[k]) aplicar[k] = conta[k];
    } else if (!e.adotado && local[k] !== undefined) subir[k] = local[k];
  }
  return { subir: subir as PrefsDaConta, aplicar: aplicar as PrefsDaConta };
}
