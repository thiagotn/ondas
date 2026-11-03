import { t as traduzir } from '../i18n/index.js';
import { createStore } from 'zustand/vanilla';
import { DEFAULT_THEME_ID } from '../themes.js';
import type { Gate, GateKind, ThemeId, WallMode } from '../types.js';

export const TOAST_MS = 3200;

/** Limites do painel de transparência (iguais aos dos sliders). */
export const OPACITY_MIN = 0.3;
export const OPACITY_MAX = 1;
export const BLUR_MAX = 40;
/** Opacidade assumida ao enviar uma imagem com o fundo ainda opaco. */
export const OPACITY_ON_UPLOAD = 0.8;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Preferências de fundo — persistidas pela plataforma (no web, IndexedDB). */
export interface BackgroundSettings {
  opacity: number;
  blur: number;
  wall: WallMode;
  /** dataURL da imagem enviada. Vazio enquanto não houver uma. */
  wallImg: string;
}

/**
 * Estado de tela que NÃO está no endereço.
 *
 * Aba, recorte da biblioteca, chip de gênero e termo de busca saíram daqui: o
 * endereço é o dono deles (`/library/offline`, `/?genre=jazz`, `/search?q=mar`),
 * e dois donos para o mesmo fato é como a aba e o `playerOpen` divergiram.
 */
export interface UiState {
  themeId: ThemeId;
  toast: string;
  gate: Gate | null;
  pickerOpen: boolean;
  pickIdx: number;
  /** Linha de comando do prompt aberta (`:`). */
  cmdOpen: boolean;
  /**
   * Linha marcada na lista, por ID.
   *
   * ID e não índice: entrar na conta põe o acervo na frente da lista e desloca
   * todo índice (ver `comCatalogoProprio`/`setTracks`). Um cursor por posição
   * passaria a apontar para outra faixa depois do login.
   */
  cursorId: string | null;
  /**
   * Modo de seleção ligado: as linhas da lista marcam em vez de tocar.
   *
   * Mora aqui, e não no endereço, porque é estado de tela como o `cursorId` — e
   * NÃO é persistido de propósito: uma marca que sobrevive ao reload é uma marca
   * invisível, que volta semanas depois e adiciona a faixa errada.
   */
  selecionando: boolean;
  /**
   * As faixas marcadas, por id.
   *
   * Por id e não por posição, como o `cursorId` e pelo mesmo motivo: a marca
   * atravessa troca de recorte e de aba, o que é o que deixa montar uma playlist
   * com faixa do acervo e faixa pública na mesma leva. Posição não sobreviveria
   * nem ao login, que põe o acervo na frente da lista.
   */
  marcadas: Readonly<Record<string, boolean>>;
  /**
   * O seletor de playlist está aberto (as marcadas vão para a que for escolhida).
   *
   * Campo próprio, e não o `pickerOpen` do tema: `t` e `4` abrem aquele, e um
   * booleano só faria uma tecla abrir o seletor errado. Os dois também não se
   * parecem por dentro — o de tema pré-visualiza ao vivo e desfaz no Esc.
   */
  seletorPlaylist: boolean;
  /** Linha sob o cursor no seletor de playlist (`j`/`k`). */
  seletorIdx: number;
  /** Simulação de queda de rede — só habilitada em build de dev. */
  simulatedOffline: boolean;
  /** Transparência do fundo (0,3–1). Em 1 o app fica idêntico ao opaco. */
  opacity: number;
  blur: number;
  wall: WallMode;
  wallImg: string;
  setThemeId(id: ThemeId): void;
  /** Toast de 3,2 s; uma mensagem nova substitui a anterior. */
  flash(msg: string): void;
  clearToast(): void;
  openGate(kind: GateKind, title: string): void;
  closeGate(): void;
  openPicker(index: number): void;
  closePicker(): void;
  setPickIdx(index: number): void;
  setCmdOpen(open: boolean): void;
  setCursor(id: string | null): void;
  /** Liga o modo de seleção, opcionalmente já marcando uma linha. */
  entrarNaSelecao(id?: string): void;
  /** Desliga o modo E limpa as marcas: ver o comentário de `marcadas`. */
  sairDaSelecao(): void;
  alternarMarca(id: string): void;
  limparMarcas(): void;
  abrirSeletorPlaylist(): void;
  fecharSeletorPlaylist(): void;
  setSeletorIdx(index: number): void;
  setSimulatedOffline(value: boolean): void;
  setOpacity(value: number): void;
  setBlur(value: number): void;
  setWall(wall: WallMode): void;
  /** Imagem enviada: passa a valer na hora e revela o efeito se o fundo estava opaco. */
  setWallImage(dataUrl: string): void;
  hydrateBackground(settings: Partial<BackgroundSettings>): void;
}

export type UiStore = ReturnType<typeof createUiStore>;

export function createUiStore(initial?: { themeId?: ThemeId; opacity?: number }) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return createStore<UiState>((set) => ({
    themeId: initial?.themeId ?? DEFAULT_THEME_ID,
    toast: '',
    gate: null,
    pickerOpen: false,
    pickIdx: 0,
    cmdOpen: false,
    cursorId: null,
    selecionando: false,
    marcadas: {},
    seletorPlaylist: false,
    seletorIdx: 0,
    simulatedOffline: false,
    opacity: clamp(initial?.opacity ?? OPACITY_MAX, OPACITY_MIN, OPACITY_MAX),
    blur: 16,
    wall: 'capa',
    wallImg: '',
    setThemeId: (themeId) => set({ themeId }),
    flash: (toast) => {
      clearTimeout(timer);
      set({ toast });
      timer = setTimeout(() => set({ toast: '' }), TOAST_MS);
    },
    clearToast: () => {
      clearTimeout(timer);
      set({ toast: '' });
    },
    openGate: (kind, title) => set({ gate: { kind, title } }),
    closeGate: () => set({ gate: null }),
    openPicker: (pickIdx) => set({ pickerOpen: true, pickIdx }),
    closePicker: () => set({ pickerOpen: false }),
    setPickIdx: (pickIdx) => set({ pickIdx }),
    setCmdOpen: (cmdOpen) => set({ cmdOpen }),
    setCursor: (cursorId) => set({ cursorId }),
    entrarNaSelecao: (id) =>
      set((st) => ({
        selecionando: true,
        marcadas: id ? { ...st.marcadas, [id]: true } : st.marcadas,
      })),
    // Fecha o seletor junto: ele só existe para mandar as marcadas a algum
    // lugar, e sair da seleção com ele aberto deixaria um painel sem assunto.
    sairDaSelecao: () => set({ selecionando: false, marcadas: {}, seletorPlaylist: false }),
    alternarMarca: (id) =>
      set((st) => {
        const marcadas = { ...st.marcadas };
        if (marcadas[id]) delete marcadas[id];
        else marcadas[id] = true;
        return { marcadas };
      }),
    limparMarcas: () => set({ marcadas: {} }),
    abrirSeletorPlaylist: () => set({ seletorPlaylist: true, seletorIdx: 0 }),
    fecharSeletorPlaylist: () => set({ seletorPlaylist: false }),
    setSeletorIdx: (seletorIdx) => set({ seletorIdx }),
    setSimulatedOffline: (simulatedOffline) => set({ simulatedOffline }),
    setOpacity: (value) => set({ opacity: clamp(value, OPACITY_MIN, OPACITY_MAX) }),
    setBlur: (value) => set({ blur: clamp(Math.round(value), 0, BLUR_MAX) }),
    setWall: (wall) => set({ wall }),
    setWallImage: (wallImg) =>
      set((st) => ({
        wallImg,
        wall: 'imagem',
        // Enviar uma imagem com o fundo opaco não mostraria nada.
        opacity: st.opacity >= OPACITY_MAX ? OPACITY_ON_UPLOAD : st.opacity,
      })),
    hydrateBackground: (settings) =>
      set((st) => ({
        opacity: clamp(settings.opacity ?? st.opacity, OPACITY_MIN, OPACITY_MAX),
        blur: clamp(Math.round(settings.blur ?? st.blur), 0, BLUR_MAX),
        wall: settings.wall ?? st.wall,
        wallImg: settings.wallImg ?? st.wallImg,
      })),
  }));
}

export function gateCopy(gate: Gate): { title: string; body: string } {
  return gate.kind === 'dl'
    ? {
        title: traduzir('gate.download.titulo'),
        body: traduzir('gate.download.corpo', { faixa: gate.title }),
      }
    : {
        title: traduzir('gate.pro.titulo', { faixa: gate.title }),
        body: traduzir('gate.pro.corpo'),
      };
}
