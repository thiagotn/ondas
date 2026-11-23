import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke do painel, contra o BUILD e com a API de mentira (`page.route`).
 * Porta 4174 — a 4173 é da PWA, e as duas suítes rodam na mesma máquina.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: { baseURL: 'http://localhost:4174', trace: 'retain-on-failure', locale: 'pt-BR' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: 'http://localhost:4174',
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
  },
});
