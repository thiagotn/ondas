import {
  createLibraryStore,
  createPlayerStore,
  createSessionStore,
  createUiStore,
  type LibrarySnapshot,
  type LibraryState,
  type PlayerState,
  type SessionState,
  type UiState,
} from '@ondas/core';
import { useStore } from 'zustand';
import { readStoredTheme } from '../theme/applyTheme';
import { kv } from './services';

export const LIBRARY_KEY = 'library';

export const uiStore = createUiStore({ themeId: readStoredTheme() });
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
