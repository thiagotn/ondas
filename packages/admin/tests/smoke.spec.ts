import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Smoke do painel de admin, com a API de mentira.
 *
 * O que se prova aqui é a costura da tela: entra com o token, lê, decide, e o
 * que o servidor recebeu é o que a pessoa pediu. As regras de verdade — quem
 * passa por `exigirAdmin`, o que o cookie alcança — são testadas na API
 * (`admin_test.go`), contra um Postgres real.
 */

const TOKEN = 'token-de-teste-do-admin';

const lerJson = (rel: string): unknown => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

/** A versão que o rodapé mostra: a que `pnpm release` escreve NESTE pacote. */
const VERSAO = (lerJson('../package.json') as { version: string }).version;

/** A nota de versão do painel, de onde a tela `/changelog` é desenhada. */
const NOTAS = lerJson('../src/release/notas.json') as { versao: string; itens: Record<string, string>[] }[];

interface ContaFalsa {
  id: string;
  email: string;
  name: string;
  status: string;
  podeEnviar: boolean;
  recebeDoBot: boolean;
  mensagem?: string;
  faixas: number;
  usadoBytes: number;
}

async function apiFalsa(page: Page) {
  let dentro = false;
  let cadastroAberto = false;
  let cotaBloqueia = true;
  const pedidos: { metodo: string; caminho: string; corpo: unknown }[] = [];
  const contas: ContaFalsa[] = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'dona@exemplo.test',
      name: 'dona',
      status: 'aprovada',
      podeEnviar: true,
      recebeDoBot: true,
      faixas: 12,
      usadoBytes: 300 * 1024 * 1024,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      email: 'nova@exemplo.test',
      name: 'Nova',
      status: 'pendente',
      podeEnviar: false,
      recebeDoBot: false,
      // Texto de fora: se o painel o desenhasse como HTML, este teste veria um
      // elemento <img> na página.
      mensagem: '<img src=x onerror=alert(1)> quero testar',
      faixas: 0,
      usadoBytes: 0,
    },
  ];
  const completa = (c: ContaFalsa) => ({
    ...c,
    criadaEm: '2026-11-01T12:00:00Z',
    planoId: 'padrao',
    planoNome: 'padrão',
    cotaExtraBytes: 0,
    cotaBytes: 1024 ** 3,
  });

  const ordensDeFaixas: (string | null)[] = [];
  await page.route('**/api/admin/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const caminho = url.pathname.replace('/api/admin', '');
    const metodo = req.method();
    const corpo = req.postData() ? JSON.parse(req.postData()!) : undefined;
    pedidos.push({ metodo, caminho, corpo });
    const json = (status: number, dados: unknown) => route.fulfill({ status, json: dados });

    if (caminho === '/sessao' && metodo === 'POST') {
      if (corpo?.token !== TOKEN) return json(401, { error: 'token inválido', code: 'token_invalido' });
      dentro = true;
      return json(200, { status: 'ok' });
    }
    if (caminho === '/sessao' && metodo === 'DELETE') {
      dentro = false;
      return json(200, { status: 'ok' });
    }
    if (!dentro) return json(401, { error: 'token inválido', code: 'token_invalido' });

    if (caminho === '/sessao') return json(200, { status: 'ok' });
    if (caminho === '/resumo') {
      return json(200, {
        contas: { pendente: contas.filter((c) => c.status === 'pendente').length, aprovada: 1, negada: 0 },
        faixas: 12,
        audioBytes: 290 * 1024 * 1024,
        capaBytes: 10 * 1024 * 1024,
        ingestoes: { pending: 0, processing: 0, ready: 12, error: 1 },
        convites: 0,
        cadastroAberto,
        acimaDaCota: 0,
      });
    }
    if (caminho === '/contas' && metodo === 'GET') {
      const status = url.searchParams.get('status');
      return json(200, {
        contas: contas.filter((c) => !status || c.status === status).map(completa),
      });
    }
    const decisao = /^\/contas\/([^/]+)\/(aprovar|negar)$/.exec(caminho);
    if (decisao && metodo === 'POST') {
      const c = contas.find((x) => x.id === decisao[1])!;
      c.status = decisao[2] === 'aprovar' ? 'aprovada' : 'negada';
      return json(200, completa(c));
    }
    const umaConta = /^\/contas\/([^/]+)$/.exec(caminho);
    if (umaConta && metodo === 'PATCH') {
      const c = contas.find((x) => x.id === umaConta[1])!;
      Object.assign(c, corpo);
      return json(200, completa(c));
    }
    if (caminho === '/config' && metodo === 'GET') return json(200, { cadastroAberto, cotaBloqueia });
    if (caminho === '/config' && metodo === 'PUT') {
      // Como o servidor: só muda a chave que veio.
      if (typeof corpo.cadastroAberto === 'boolean') cadastroAberto = corpo.cadastroAberto;
      if (typeof corpo.cotaBloqueia === 'boolean') cotaBloqueia = corpo.cotaBloqueia;
      return json(200, { cadastroAberto, cotaBloqueia });
    }
    if (caminho === '/planos' && metodo === 'GET') {
      return json(200, {
        planos: [
          { id: 'padrao', nome: 'padrão', cotaBytes: 1024 ** 3, contas: 2, criadoEm: '2026-11-01T12:00:00Z' },
        ],
      });
    }
    if (caminho === '/convites' && metodo === 'GET') return json(200, { convites: [] });
    if (caminho === '/faixas' && metodo === 'GET') {
      ordensDeFaixas.push(url.searchParams.get('ordem'));
      return json(200, { faixas: [] });
    }
    return json(404, { error: 'não encontrado' });
  });

  return { pedidos, contas, ordensDeFaixas };
}

async function entrar(page: Page) {
  await page.goto('/');
  await page.getByLabel('Token de admin').fill(TOKEN);
  await page.getByRole('button', { name: '[entrar]' }).click();
  await expect(page.getByRole('heading', { name: 'visão geral' })).toBeVisible();
}

test('sem sessão o painel pede o token, e token errado não entra', async ({ page }) => {
  await apiFalsa(page);
  await page.goto('/accounts');

  await expect(page.getByLabel('Token de admin')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'contas' })).toBeHidden();

  await page.getByLabel('Token de admin').fill('errado');
  await page.getByRole('button', { name: '[entrar]' }).click();
  await expect(page.getByRole('alert')).toHaveText('token inválido');
});

test('o token não fica guardado no navegador depois de entrar', async ({ page }) => {
  await apiFalsa(page);
  await entrar(page);

  const guardado = await page.evaluate(() =>
    JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]),
  );
  expect(guardado).not.toContain(TOKEN);
});

test('a visão geral mostra o que espera decisão e leva até lá', async ({ page }) => {
  await apiFalsa(page);
  await entrar(page);

  await expect(page.getByText('300,0 MB', { exact: false }).first()).toBeVisible();
  await page.getByRole('link', { name: /pedidos em análise/ }).click();
  await expect(page).toHaveURL(/status=pendente/);
  await expect(page.getByRole('link', { name: 'nova@exemplo.test' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'dona@exemplo.test' })).toBeHidden();
});

test('aprovar um pedido e liberar o envio mandam o que foi pedido', async ({ page }) => {
  const { pedidos, contas } = await apiFalsa(page);
  await entrar(page);
  await page.goto('/accounts?status=pendente');
  // `goto` recarrega a página: a sessão vem do cookie, que aqui é o estado da
  // API de mentira.
  const linha = page.getByRole('row', { name: /nova@exemplo.test/ });

  // A mensagem do pedido é desenhada como TEXTO.
  await expect(linha.getByText('<img src=x onerror=alert(1)> quero testar', { exact: false })).toBeVisible();
  expect(await page.locator('img').count()).toBe(0);

  await linha.getByRole('switch', { name: 'nova@exemplo.test pode enviar' }).click();
  await expect.poll(() => contas[1]!.podeEnviar).toBe(true);

  await linha.getByRole('button', { name: '[aprovar]' }).click();
  await expect.poll(() => contas[1]!.status).toBe('aprovada');
  // Saiu do recorte de pendentes.
  await expect(page.getByText('nenhuma conta neste recorte.')).toBeVisible();

  expect(pedidos).toContainEqual({
    metodo: 'PATCH',
    caminho: '/contas/22222222-2222-4222-8222-222222222222',
    corpo: { podeEnviar: true },
  });
});

test('abrir o cadastro vale na tela e no servidor', async ({ page }) => {
  const { pedidos } = await apiFalsa(page);
  await entrar(page);
  await page.getByRole('link', { name: 'cadastro', exact: true }).click();

  await expect(page.getByText(/fechado: só entra quem tem convite/)).toBeVisible();
  await page.getByRole('switch', { name: 'cadastro aberto' }).click();
  await expect(page.getByText(/aberto: qualquer pessoa pode pedir conta/)).toBeVisible();
  expect(pedidos).toContainEqual({ metodo: 'PUT', caminho: '/config', corpo: { cadastroAberto: true } });
});

test('desligar o bloqueio por cota manda só essa chave', async ({ page }) => {
  const { pedidos } = await apiFalsa(page);
  await entrar(page);
  await page.getByRole('link', { name: 'planos', exact: true }).click();

  await expect(page.getByText(/bloqueia: conta acima da cota não recebe faixa nova/)).toBeVisible();
  await page.getByRole('switch', { name: 'a cota bloqueia envio' }).click();
  await expect(page.getByText(/só mede: a cota aparece nas telas/)).toBeVisible();
  // O cadastro não foi junto no pedido: mexer numa chave não mexe na outra.
  expect(pedidos).toContainEqual({ metodo: 'PUT', caminho: '/config', corpo: { cotaBloqueia: false } });
});

test('sessão vencida no meio do uso volta para a entrada', async ({ page }) => {
  await apiFalsa(page);
  await entrar(page);
  // O servidor esquece a sessão (cookie vencido, token trocado).
  await page.evaluate(() => fetch('/api/admin/sessao', { method: 'DELETE' }));

  await page.getByRole('link', { name: 'contas', exact: true }).click();
  await expect(page.getByLabel('Token de admin')).toBeVisible();
});

test('no celular a página não rola de lado: quem rola é a tabela', async ({ page }) => {
  await apiFalsa(page);
  await entrar(page);
  await page.getByRole('link', { name: 'contas', exact: true }).click();
  await expect(page.getByRole('link', { name: 'dona@exemplo.test' })).toBeVisible();

  const sobra = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(sobra).toBeLessThanOrEqual(0);
});

test('a lista de contas filtra pelo texto e ordena pela coluna, e o recorte fica no endereço', async ({
  page,
}) => {
  await apiFalsa(page);
  await entrar(page);
  await page.getByRole('link', { name: 'contas', exact: true }).click();
  const linhas = page.locator('tbody tr');
  await expect(linhas).toHaveCount(2);
  // A ordem do servidor: a dona primeiro.
  await expect(linhas.first()).toContainText('dona@exemplo.test');

  // Dois cliques na coluna: A→Z e depois Z→A.
  const coluna = page.getByRole('columnheader', { name: 'conta' });
  await coluna.getByRole('button').click();
  await expect(coluna).toHaveAttribute('aria-sort', 'ascending');
  await coluna.getByRole('button').click();
  await expect(coluna).toHaveAttribute('aria-sort', 'descending');
  await expect(linhas.first()).toContainText('nova@exemplo.test');
  await expect(page).toHaveURL(/ord=-conta/);

  // Coluna de número começa pelo maior: é a pergunta que se faz a ela.
  await page.getByRole('columnheader', { name: 'ocupação' }).getByRole('button').click();
  await expect(linhas.first()).toContainText('dona@exemplo.test');
  await expect(page).toHaveURL(/ord=-usado/);

  // O filtro ignora acento e caixa, e procura também no status.
  await page.getByLabel('Filtrar contas').fill('ANALISE');
  await expect(linhas).toHaveCount(1);
  await expect(linhas.first()).toContainText('nova@exemplo.test');
  await expect(page.getByText('1 de 2')).toBeVisible();

  await page.getByLabel('Filtrar contas').fill('ninguém com esse nome');
  await expect(linhas).toHaveCount(0);
  await expect(page.getByText('nada casa com o filtro.')).toBeVisible();

  // O recorte sobrevive a recarregar a página.
  await page.getByLabel('Filtrar contas').fill('dona');
  await page.reload();
  await expect(page.getByLabel('Filtrar contas')).toHaveValue('dona');
  await expect(linhas).toHaveCount(1);
  await expect(page.getByRole('columnheader', { name: 'ocupação' })).toHaveAttribute(
    'aria-sort',
    'descending',
  );
});

test('o tema troca na hora e continua depois de recarregar', async ({ page }) => {
  await apiFalsa(page);
  await entrar(page);
  const fundo = () =>
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim());
  expect(await fundo()).toBe('#1e1e2e');

  await page.getByRole('button', { name: /^Tema:/ }).click();
  await page.getByRole('menuitemradio', { name: /github light/ }).click();
  expect(await fundo()).toBe('#ffffff');
  expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe('light');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'visão geral' })).toBeVisible();
  expect(await fundo()).toBe('#ffffff');
  await expect(page.getByRole('button', { name: 'Tema: github light' })).toBeVisible();
});

test('o idioma troca o painel inteiro e continua depois de recarregar', async ({ page }) => {
  await apiFalsa(page);
  await entrar(page);

  await page.getByRole('button', { name: /^Idioma:/ }).click();
  await page.getByRole('menuitemradio', { name: /english/ }).click();
  // Trocar de idioma recarrega; a sessão (cookie) continua valendo.
  await expect(page.getByRole('heading', { name: 'overview' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('link', { name: 'accounts', exact: true })).toBeVisible();
  // Número e data acompanham: ponto decimal, e não vírgula.
  await expect(page.getByText('300.0 MB', { exact: false }).first()).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'overview' })).toBeVisible();

  // E volta: o seletor mostra cada idioma na língua dele.
  await page.getByRole('button', { name: /^Language:/ }).click();
  await page.getByRole('menuitemradio', { name: /português/ }).click();
  await expect(page.getByRole('heading', { name: 'visão geral' })).toBeVisible();
});

test('na tela de entrada já dá para trocar o idioma', async ({ page }) => {
  await apiFalsa(page);
  await page.goto('/');
  await page.getByRole('button', { name: /^Idioma:/ }).click();
  await page.getByRole('menuitemradio', { name: /español/ }).click();
  await expect(page.getByLabel('Token de admin')).toBeVisible();
  await expect(page.getByRole('button', { name: '[entrar]' })).toBeVisible();
  await expect(page.getByText('pega el token de admin', { exact: false })).toBeVisible();
});

test('os endereços são em inglês, e os antigos levam à mesma tela com o recorte', async ({ page }) => {
  await apiFalsa(page);
  await entrar(page);

  await page.getByRole('link', { name: 'contas', exact: true }).click();
  await expect(page).toHaveURL(/\/accounts$/);

  await page.goto('/contas?status=pendente');
  await expect(page).toHaveURL(/\/accounts\?status=pendente$/);
  await expect(page.getByRole('row', { name: /nova@exemplo.test/ })).toBeVisible();

  await page.goto('/contas/22222222-2222-4222-8222-222222222222');
  await expect(page).toHaveURL(/\/accounts\/22222222-2222-4222-8222-222222222222$/);

  await page.goto('/historico');
  await expect(page).toHaveURL(/\/history$/);
});

test('a tela de faixas abre pedindo as mais novas', async ({ page }) => {
  const { ordensDeFaixas } = await apiFalsa(page);
  await entrar(page);
  await page.goto('/tracks');

  await expect(page.getByText('o acervo está vazio.')).toBeVisible();
  expect(ordensDeFaixas[0]).toBe('recentes');
});

test('a versão do rodapé abre as notas do painel, com a versão em uso marcada', async ({ page }) => {
  await apiFalsa(page);
  await entrar(page);

  // A versão e a nota saem dos arquivos do PAINEL — não dos do app, que têm
  // outro número. Fixá-las aqui quebraria o teste na próxima entrega.
  await page.getByRole('link', { name: `Notas da versão ${VERSAO}` }).click();
  await expect(page).toHaveURL(/\/changelog$/);
  await expect(page.getByRole('heading', { name: 'notas da versão' })).toBeVisible();
  await expect(page.getByRole('heading', { name: `v${VERSAO}` })).toContainText('[em uso]');
  await expect(page.getByText(NOTAS[0]!.itens[0]!['pt-BR']!)).toBeVisible();
});
