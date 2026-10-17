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
 * SPA: `/buscar`, `/biblioteca` e `/login` são rotas do React Router, não arquivos.
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

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
