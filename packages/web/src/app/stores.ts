import {
  createLibraryStore,
  createPlayerStore,
  createSessionStore,
  createUiStore,
  type BackgroundSettings,
  type LibrarySnapshot,
  type LibraryState,
  type PlayerState,
  type SessionState,
  type UiState,
} from '@ondas/core';
import { useStore } from 'zustand';
import { readStoredTheme } from '../theme/applyTheme';
import { DEFAULT_OPACITY, kv } from './services';

export const LIBRARY_KEY = 'library';
export const BACKGROUND_KEY = 'background';

export const uiStore = createUiStore({ themeId: readStoredTheme(), opacity: DEFAULT_OPACITY });

/**
 * Preferências de fundo no IndexedDB, não no localStorage: `wallImg` é um
 * dataURL de até ~1MB, que estoura a cota de 5MB do localStorage em poucas
 * trocas de imagem.
 */
uiStore.subscribe((st, prev) => {
  if (
    st.opacity === prev.opacity &&
    st.blur === prev.blur &&
    st.wall === prev.wall &&
    st.wallImg === prev.wallImg
  ) {
    return;
  }
  const { opacity, blur, wall, wallImg } = st;
  void kv.set<BackgroundSettings>(BACKGROUND_KEY, { opacity, blur, wall, wallImg });
});

export const playerStore = createPlayerStore();
export const sessionStore = createSessionStore();
export const libraryStore = createLibraryStore({
  persist: (snapshot) => {
    void kv.set<LibrarySnapshot>(LIBRARY_KEY, snapshot);
  },
});

export const useUi = <T>(selector: (s: UiState) => T): T => useStore(uiStore, selector);
export const usePlayer = <T>(selector: (s: PlayerState) => T): T => useStore(playerStore, selector);
export const useSession = <T>(selector: (s: SessionState) => T): T => useStore(sessionStore, selector);
export const useLibrary = <T>(selector: (s: LibraryState) => T): T => useStore(libraryStore, selector);
