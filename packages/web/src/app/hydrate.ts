import type { BackgroundSettings, LibrarySnapshot } from '@ondas/core';
import * as historico from './historico';
import { sincronizar } from './likes';
import { adotarIdiomaDaConta } from './idioma';
import { carregarPlaylists } from './playlists';
import * as prefs from './prefs';
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
  // Sem eco: isto é o disco voltando para a memória, e não alguém mexendo no
  // slider — não pode entrar na fila do que sobe para a conta (`app/prefs.ts`).
  if (background) prefs.aplicarSemEco(() => uiStore.getState().hydrateBackground(background));
  if (snapshot) libraryStore.getState().hydrate(snapshot);
  sessionStore.getState().markRestored(session);

  // A aparência da conta. Vem DENTRO da sessão que acabou de chegar, então não
  // custa pedido nenhum; e fica depois do fundo local, porque é sobre ele que
  // ela decide. O idioma é o único que não se aplica no lugar: se a conta fala
  // outro e este aparelho ainda não sabia, a página navega — uma vez.
  if (session) {
    void prefs.iniciar(session).then((daConta) => {
      if (daConta) adotarIdiomaDaConta(daConta);
    });
  }

  const present = await offlineStore.keys();
  libraryStore.getState().reconcile(present);

  // As curtidas são da conta; o que foi lido acima é espelho. Sem `await` de
  // propósito: o boot não pode ficar preso na rede, e a tela já desenhou os
  // corações do espelho — é exatamente para isso que ele existe.
  void sincronizar();
  // Mesma regra, mesma razão: o espelho já desenhou a fileira de playlists, e o
  // boot não pode ficar preso na rede esperando a versão autoritativa.
  void carregarPlaylists();
  // E o marcador — onde a conta parou. O espelho arma o player sem rede; o
  // servidor corrige depois se outro aparelho ouviu mais recentemente.
  void historico.iniciar();
}
