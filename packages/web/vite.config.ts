import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/** bg do Catppuccin Mocha (tema padrão) — o `theme-color` real é trocado em runtime. */
const DEFAULT_BG = '#1e1e2e';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Service Worker próprio: o shell é pré-cacheado, o áudio não passa por aqui.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      // O registro é feito em `main.tsx`, então nada é injetado no HTML.
      injectRegister: null,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,woff2,svg,png,ico,webmanifest}'],
        // As faixas baixadas vivem no cache `ondas-offline`, fora do precache.
        globIgnores: ['**/node_modules/**', 'offline/**'],
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
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: { port: 5173 },
  preview: { port: 4173 },
  build: { target: 'es2022', sourcemap: true },
});
