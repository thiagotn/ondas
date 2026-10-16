import type { LibrarySnapshot } from '@ondas/core';
import { auth, kv, offlineStore } from './services';
import { libraryStore, LIBRARY_KEY, sessionStore } from './stores';

/**
 * Carrega o que foi persistido: sessão, curtidas e índice offline. O índice é
 * conferido contra a Cache API — o iOS evacua armazenamento de PWAs ociosas, e
 * uma faixa marcada como `[off]` que não existe mais não pode continuar listada.
 */
export async function hydrate(): Promise<void> {
  const [snapshot, session] = await Promise.all([
    kv.get<LibrarySnapshot>(LIBRARY_KEY),
    auth.restore(),
  ]);
  if (snapshot) libraryStore.getState().hydrate(snapshot);
  sessionStore.getState().markRestored(session);

  const present = await offlineStore.keys();
  libraryStore.getState().reconcile(present);
}
