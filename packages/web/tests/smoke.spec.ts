import { expect, test, type Page } from '@playwright/test';

/**
 * Smoke da PWA. Roda contra o build de produção (ver `webServer` no config) e
 * usa o catálogo demo: a API do Audius fica bloqueada para o teste não depender
 * de rede nem de terceiros.
 */
async function blockAudius(page: Page) {
  await page.route('**/api.audius.co/**', (route) => route.abort());
  await page.route('**/*.audius.co/**', (route) => route.abort());
}

test.beforeEach(async ({ page }) => {
  await blockAudius(page);
});

/**
 * A abertura cobre a tela a cada boot. Um toque a dispensa — e ela também fecha
 * sozinha no teto de 4,5s, daí o clique tolerar não encontrar nada.
 */
async function skipSplash(page: Page) {
  const splash = page.getByRole('button', { name: 'pular abertura' });
  await splash.click({ timeout: 6000 }).catch(() => {});
  await expect(splash).toBeHidden();
}

test('visitante entra, troca de tema, toca e abre o full player', async ({ page }) => {
  await page.goto('/');
  await skipSplash(page);

  // Sem sessão, a rota raiz manda para o login.
  await expect(page.getByText('ondas — login')).toBeVisible();
  await expect(page.getByLabel('ondas', { exact: true })).toBeVisible();
  await expect(page.getByText('lado A', { exact: true })).toBeVisible();

  // Credenciais inválidas são recusadas sem sair da tela.
  await page.getByPlaceholder('voce@email.com').fill('thiago');
  await page.getByRole('button', { name: /entrar — catálogo completo/ }).click();
  await expect(page.getByText('error: e-mail inválido')).toBeVisible();

  await page.getByRole('button', { name: /continuar como visitante/ }).click();

  // Catálogo demo (a API está bloqueada) e aviso de visitante.
  await expect(page.getByText(/catálogo demo/)).toBeVisible();
  await expect(page.getByText(/sessão de visitante/)).toBeVisible();
  await expect(page.getByText('Maré Baixa')).toBeVisible();

  // Tema: aplica na hora e sobrevive ao reload.
  await page.getByRole('button', { name: 'Trocar tema' }).click();
  await expect(page.getByRole('dialog', { name: 'ondas +list-themes' })).toBeVisible();
  await page.getByRole('button', { name: /Nord/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'nord');

  // A sessão de visitante é efêmera (como no protótipo): recarregar volta ao
  // login, mas o tema escolhido continua valendo.
  await page.reload();
  await skipSplash(page);
  await expect(page.getByText('ondas — login')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'nord');
  await page.getByRole('button', { name: /continuar como visitante/ }).click();

  // Play: a primeira faixa entra na linha do player.
  await page.getByRole('button', { name: /Maré Baixa/ }).click();
  await expect(page.getByText('Maré Baixa — Lia Sombra')).toBeVisible();
  await expect(page.getByText('PLAY', { exact: true })).toBeVisible();

  // Full player via overlay na query string, e o voltar o fecha.
  await page.getByRole('button', { name: 'Abrir player' }).click();
  await expect(page).toHaveURL(/player=1/);
  await expect(page.getByRole('heading', { name: 'Maré Baixa' })).toBeVisible();
  await expect(page.getByText('agora-tocando — #ambient')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Maré Baixa' })).toBeHidden();
});

test('faixa [pro] abre o gate de permissão para visitante', async ({ page }) => {
  await page.goto('/login');
  await skipSplash(page);
  await page.getByRole('button', { name: /continuar como visitante/ }).click();

  // Cada 3ª faixa é [pro] enquanto a API não informa o campo.
  await expect(page.getByText('[pro]').first()).toBeVisible();
  await page.getByRole('button', { name: /Neon na Chuva/ }).click();

  const gate = page.getByRole('alertdialog', { name: 'permissão negada' });
  await expect(gate).toBeVisible();
  await expect(gate).toContainText('"Neon na Chuva" é uma faixa [pro]');
  await page.keyboard.press('Escape');
  await expect(gate).toBeHidden();
});

test('login libera o catálogo e a biblioteca mostra a conta', async ({ page }) => {
  await page.goto('/login');
  await skipSplash(page);
  await page.getByPlaceholder('voce@email.com').fill('thiago@ondas.app');
  await page.getByPlaceholder('••••').fill('senha');
  await page.getByRole('button', { name: /entrar — catálogo completo/ }).click();

  await expect(page.getByText(/autenticado como thiago/)).toBeVisible();
  await expect(page.getByText('@thiago')).toBeVisible();
  await expect(page.getByText(/sessão de visitante/)).toBeHidden();

  // Atalho `3` abre a biblioteca.
  await page.keyboard.press('3');
  await expect(page).toHaveURL(/biblioteca/);
  await expect(page.getByText('catálogo completo + offline')).toBeVisible();
  await expect(page.getByText('0 faixas · 0.0 MB')).toBeVisible();
  await expect(page.getByText('vazio — pressione [l] ou o coração para curtir.')).toBeVisible();
});

test('busca filtra por artista e mostra a mensagem de grep vazio', async ({ page }) => {
  await page.goto('/login');
  await skipSplash(page);
  await page.getByRole('button', { name: /continuar como visitante/ }).click();

  await page.keyboard.press('/');
  const input = page.getByLabel('Buscar faixa, artista ou gênero');
  await expect(input).toBeFocused();

  await input.fill('bruma');
  await expect(page.getByText('# 2 resultados')).toBeVisible();
  await expect(page.getByText('Fio de Cobre')).toBeVisible();

  await input.fill('zzz');
  await expect(page.getByText('grep: nenhum resultado para "zzz"')).toBeVisible();
});

test('abertura toca no boot e volta pelo logo da barra de abas', async ({ page }) => {
  await page.goto('/login');

  const splash = page.getByRole('button', { name: 'pular abertura' });
  await expect(splash).toBeVisible();
  await expect(page.getByText('lado A · streaming independente')).toBeVisible();

  // Um toque pula — não é preciso esperar os 2,2s.
  await splash.click();
  await expect(splash).toBeHidden();

  await page.getByRole('button', { name: /continuar como visitante/ }).click();
  await page.getByRole('button', { name: 'ondas — rever abertura' }).click();
  await expect(splash).toBeVisible();
  await splash.click();
  await expect(splash).toBeHidden();
});
