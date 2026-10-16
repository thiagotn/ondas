import { createStore } from 'zustand/vanilla';
import { DEFAULT_THEME_ID } from '../themes.js';
import type { Gate, GateKind, LibrarySegment, TabId, ThemeId } from '../types.js';

export const TOAST_MS = 3200;

export interface UiState {
  tab: TabId;
  /** Busca. */
  q: string;
  genre: string;
  seg: LibrarySegment;
  themeId: ThemeId;
  toast: string;
  gate: Gate | null;
  playerOpen: boolean;
  pickerOpen: boolean;
  pickIdx: number;
  /** Simulação de queda de rede — só habilitada em build de dev. */
  simulatedOffline: boolean;
  setTab(tab: TabId): void;
  setQ(q: string): void;
  setGenre(genre: string): void;
  setSeg(seg: LibrarySegment): void;
  setThemeId(id: ThemeId): void;
  /** Toast de 3,2 s; uma mensagem nova substitui a anterior. */
  flash(msg: string): void;
  clearToast(): void;
  openGate(kind: GateKind, title: string): void;
  closeGate(): void;
  setPlayerOpen(open: boolean): void;
  openPicker(index: number): void;
  closePicker(): void;
  setPickIdx(index: number): void;
  setSimulatedOffline(value: boolean): void;
}

export type UiStore = ReturnType<typeof createUiStore>;

export function createUiStore(initial?: { themeId?: ThemeId; tab?: TabId }) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return createStore<UiState>((set) => ({
    tab: initial?.tab ?? 'home',
    q: '',
    genre: 'tudo',
    seg: 'liked',
    themeId: initial?.themeId ?? DEFAULT_THEME_ID,
    toast: '',
    gate: null,
    playerOpen: false,
    pickerOpen: false,
    pickIdx: 0,
    simulatedOffline: false,
    setTab: (tab) => set({ tab }),
    setQ: (q) => set({ q }),
    setGenre: (genre) => set({ genre }),
    setSeg: (seg) => set({ seg }),
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
    setPlayerOpen: (playerOpen) => set({ playerOpen }),
    openPicker: (pickIdx) => set({ pickerOpen: true, pickIdx }),
    closePicker: () => set({ pickerOpen: false }),
    setPickIdx: (pickIdx) => set({ pickIdx }),
    setSimulatedOffline: (simulatedOffline) => set({ simulatedOffline }),
  }));
}

export function gateCopy(gate: Gate): { title: string; body: string } {
  return gate.kind === 'dl'
    ? {
        title: 'downloads exigem login',
        body: `entre na sua conta para salvar "${gate.title}" no aparelho e ouvir sem conexão.`,
      }
    : {
        title: `"${gate.title}" é uma faixa [pro]`,
        body: 'entre gratuitamente para liberar o catálogo completo — ou continue ouvindo as faixas grátis.',
      };
}
