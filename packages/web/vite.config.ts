import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json';

/** bg do Catppuccin Mocha (tema padrão) — o `theme-color` real é trocado em runtime. */
const DEFAULT_BG = '#1e1e2e';

export default defineConfig({
  // A versão que a janela `ondas --about` mostra. Vem do `package.json` para
  // não haver um segundo lugar a lembrar de atualizar.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    VitePWA({
      // Service Worker próprio: o shell é pré-cacheado, o áudio não passa por aqui.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // `prompt`, e não `autoUpdate`: em `autoUpdate` a própria biblioteca
      // chama `window.location.reload()` quando um SW novo ativa. Com o
      // `skipWaiting()` que havia no `sw.ts`, isso caía ~1s depois de abrir e
      // a abertura rodava duas vezes — pior, um deploy no meio de uma música
      // recarregava a página e calava o player. Quem decide a hora agora é
      // `app/atualizacao.ts`.
      registerType: 'prompt',
      // O registro é feito em `main.tsx`, então nada é injetado no HTML.
      injectRegister: null,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,woff2,svg,png,ico,webmanifest}'],
        // As faixas baixadas vivem no cache `ondas-offline`, fora do precache.
        // As telas de abertura do iOS também ficam de fora: são ~830KB que o
        // Safari busca na hora de instalar, não o SW, e inchariam o precache.
        globIgnores: ['**/node_modules/**', 'offline/**', 'splash/**'],
      },
      devOptions: { enabled: false, type: 'module' },
      manifest: {
        name: 'Ondas — streaming de música independente',
        short_name: 'Ondas',
        description: 'Player de música com estética de terminal, com faixas offline.',
        lang: 'pt-BR',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: DEFAULT_BG,
        theme_color: DEFAULT_BG,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
    }),
  ],
  server: { port: 5173 },
  preview: { port: 4173 },
  build: { target: 'es2022', sourcemap: true },
});
