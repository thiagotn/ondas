/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

/**
 * Service Worker do app shell.
 *
 * As faixas baixadas **não** passam por aqui: quem grava e lê é o
 * `CacheOfflineStore` (cache `ondas-offline`), para o índice da biblioteca e os
 * bytes no disco nunca divergirem. Streams de áudio também ficam de fora — são
 * grandes, parciais (Range) e não devem ocupar o cache do shell.
 */
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

/**
 * SPA: `/search`, `/library/<recorte>`, `/t/<faixa>` e `/login` são rotas do React
 * Router, não arquivos.
 * Sem esta rota, recarregar numa delas offline daria erro de rede — o nginx resolve
 * isso online, mas offline quem responde é o SW.
 */
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    // O healthz é das probes do k8s e do monitor da Homepage: precisa ir à rede.
    // `/api/` também: as chamadas do app não são navegações e já passam direto,
    // mas abrir /api/acervo na barra de endereços É uma navegação — sem isto o
    // SW devolveria o shell do app no lugar do JSON, o que atrapalha depurar.
    denylist: [/^\/healthz$/, /^\/sw\.js$/, /^\/api\//],
  }),
);

/**
 * A troca de versão é decidida pela PÁGINA, não aqui.
 *
 * Havia um `skipWaiting()` no install, e com `registerType: 'autoUpdate'` a
 * biblioteca recarregava a página assim que este SW ativasse — ~1s depois de
 * abrir, o tempo de pré-cachear os arquivos do shell. A abertura rodava duas
 * vezes, e um deploy no meio de uma faixa calava o player sem recado.
 *
 * Agora o SW novo espera, e `app/atualizacao.ts` manda `SKIP_WAITING` quando
 * sabe que é seguro. Sem a mensagem, a versão nova entra no próximo boot, que
 * é o comportamento padrão do navegador.
 */
self.addEventListener('message', (event) => {
  const dado: unknown = event.data;
  if ((dado as { type?: unknown } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});

/**
 * `clients.claim()` assume a página JÁ ABERTA depois de ativar. É o que faz o
 * `controllerchange` disparar nela — e é por esse evento que a página se
 * recarrega, para não seguir rodando um build cujos chunks o
 * `cleanupOutdatedCaches()` acabou de apagar.
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
