import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  // `locale` explícito: o app agora detecta idioma pelo navegador, e o padrão
  // do Chromium headless é inglês — sem isto a suíte inteira seria
  // redirecionada para `/en` e afirmaria frases em português numa tela em
  // inglês. Os testes dos outros dois idiomas navegam direto para o prefixo,
  // então não dependem disto.
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure', locale: 'pt-BR' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
  },
});
