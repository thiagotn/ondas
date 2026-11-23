import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

/**
 * O painel de administração do ondas.
 *
 * É uma aplicação SEPARADA da PWA de propósito: nada do que está aqui entra no
 * bundle que todo visitante baixa, e ela é servida em outro host. Sem service
 * worker e sem manifest — painel de admin offline, lendo dado velho do cache,
 * é pior do que painel fora do ar.
 *
 * Em dev a API não está na mesma origem, então o `/api` é repassado. Em
 * produção quem faz isso é o Ingress, que neste host só deixa passar
 * `/api/admin`.
 */
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { '/api': process.env['ONDAS_API'] ?? 'http://localhost:8080' },
  },
  preview: { port: 4174 },
  build: { target: 'es2022', sourcemap: true },
});
