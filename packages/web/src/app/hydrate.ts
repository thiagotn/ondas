import type { BackgroundSettings, LibrarySnapshot } from '@ondas/core';
import { auth, kv, offlineStore } from './services';
import { BACKGROUND_KEY, libraryStore, LIBRARY_KEY, sessionStore, uiStore } from './stores';

/**
 * Carrega o que foi persistido: sessão, curtidas, preferências de fundo e o
 * índice offline. O índice é
 * conferido contra a Cache API — o iOS evacua armazenamento de PWAs ociosas, e
 * uma faixa marcada como `[off]` que não existe mais não pode continuar listada.
 */
export async function hydrate(): Promise<void> {
  const [snapshot, session, background] = await Promise.all([
    kv.get<LibrarySnapshot>(LIBRARY_KEY),
    auth.restore(),
    kv.get<BackgroundSettings>(BACKGROUND_KEY),
  ]);
  if (background) uiStore.getState().hydrateBackground(background);
  if (snapshot) libraryStore.getState().hydrate(snapshot);
  sessionStore.getState().markRestored(session);

  const present = await offlineStore.keys();
  libraryStore.getState().reconcile(present);
}
