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

/**
 * Forma de onda de mentira com relevo conhecido: metade no teto, metade em
 * silêncio. `_` é o último caractere do alfabeto de picos (valor cheio) e `A`
 * é o primeiro (zero) — ver `packages/core/src/waveform.ts`.
 */
const PICOS_METADE = '_'.repeat(100) + 'A'.repeat(100);

/**
 * Endereço da faixa — o do link que se manda para alguém E o do player cheio,
 * que é a mesma coisa desde que ele deixou de ser `?player=1`. Os ids demo são
 * alfanuméricos, logo parseáveis.
 */
const LINK_DEMO = '/t/lia-sombra-mare-baixa-demo0';
/** `Fio de Cobre`, de `Bruma` — a faixa `lofi`, usada com o chip de gênero. */
const LINK_LOFI = '/t/bruma-fio-de-cobre-demo3';

/**
 * WAV de silêncio, montado na hora.
 *
 * Existe porque o `/audio` do acervo precisa devolver áudio TOCÁVEL: sem isso
 * o elemento dispara `error`, o controller pula para a próxima faixa (é o
 * comportamento certo dele) e o teste nunca chega a ver a faixa do acervo no
 * player.
 */
function wavDeSilencio(segundos: number): Buffer {
  const taxa = 8000;
  const amostras = taxa * segundos;
  const dados = Buffer.alloc(amostras * 2);
  const cabecalho = Buffer.alloc(44);
  cabecalho.write('RIFF', 0);
  cabecalho.writeUInt32LE(36 + dados.length, 4);
  cabecalho.write('WAVEfmt ', 8);
  cabecalho.writeUInt32LE(16, 16); // tamanho do bloco fmt
  cabecalho.writeUInt16LE(1, 20); // PCM
  cabecalho.writeUInt16LE(1, 22); // mono
  cabecalho.writeUInt32LE(taxa, 24);
  cabecalho.writeUInt32LE(taxa * 2, 28); // bytes por segundo
  cabecalho.writeUInt16LE(2, 32); // alinhamento
  cabecalho.writeUInt16LE(16, 34); // bits por amostra
  cabecalho.write('data', 36);
  cabecalho.writeUInt32LE(dados.length, 40);
  return Buffer.concat([cabecalho, dados]);
}

/** Faixas do acervo que a API falsa devolve para quem está logado. */
const ACERVO = [
  {
    id: 'acervo:11111111-1111-4111-8111-111111111111',
    title: 'Fita Caseira',
    artist: 'Eu Mesmo',
    genre: 'acervo',
    dur: 184,
    // Caminho relativo: `artworkSources` só reescreve host de URL absoluta do
    // Audius, então este chega intacto ao <img>. A faixa do acervo é a única
    // do e2e com capa, e é por ela que o toque longo na imagem é testado.
    art: '/capa-teste.png',
    stream: '/api/acervo/11111111-1111-4111-8111-111111111111/audio',
    peaks: PICOS_METADE,
    premium: false,
  },
];

/**
 * A API do acervo, de mentira.
 *
 * O build de produção que os testes servem não tem backend, e a auth agora é
 * de verdade — sem isto, nenhum login passaria. O stub imita o CONTRATO da API
 * real: mesmos status e mesmas mensagens em pt-BR, porque é isso que a tela
 * exibe cru.
 *
 * Risco assumido: stub e API podem divergir. O contrato de verdade é coberto
 * pelos testes Go (status e mensagem de cada rota); aqui o que se testa é a
 * PWA reagindo a ele.
 */
async function stubApi(page: Page) {
  let logado = false;
  // O acervo cresce durante o teste de envio: é assim que se prova que a
  // faixa nova aparece na lista depois da ingestão.
  const acervo = ACERVO.map((t) => ({ ...t }));
  let enviosRecebidos = 0;

  await page.route('**/api/auth/login', async (route) => {
    const { email, password } = JSON.parse(route.request().postData() ?? '{}');
    if (!/.+@.+\..+/.test(email ?? '')) {
      return route.fulfill({ status: 400, json: { error: 'e-mail inválido' } });
    }
    if ((password ?? '').length < 8) {
      return route.fulfill({ status: 400, json: { error: 'senha precisa de 8+ caracteres' } });
    }
    logado = true;
    return route.fulfill({ status: 200, json: { name: email.split('@')[0], email } });
  });

  await page.route('**/api/auth/logout', async (route) => {
    logado = false;
    return route.fulfill({ status: 200, json: { status: 'ok' } });
  });

  await page.route('**/api/auth/me', async (route) =>
    logado
      ? route.fulfill({ status: 200, json: { name: 'thiago', email: 'thiago@ondas.app' } })
      : route.fulfill({ status: 401, json: { error: 'sessão expirada' } }),
  );

  await page.route('**/api/acervo', async (route) =>
    logado
      ? route.fulfill({ status: 200, json: { tracks: acervo } })
      : route.fulfill({ status: 401, json: { error: 'sessão expirada' } }),
  );

  // A capa da faixa do acervo: 1x1 transparente, só para existir um <img>.
  await page.route('**/capa-teste.png', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    }),
  );

  // O `/audio` da API real devolve um 302 para a URL assinada do R2; aqui os
  // bytes vêm direto, porque o que o teste exercita é a PWA tocando a faixa,
  // não a assinatura (essa é coberta pelos testes Go).
  await page.route('**/api/acervo/*/audio', async (route) =>
    logado
      ? route.fulfill({ status: 200, contentType: 'audio/wav', body: wavDeSilencio(4) })
      : route.fulfill({ status: 401, json: { error: 'sessão expirada' } }),
  );

  // --- envio de arquivo (fase 4) ---

  // 1) a vaga: a API devolve um PUT assinado. Aqui ele aponta para um bucket
  //    de mentira, servido por `page.route` — o teste prova que os bytes vão
  //    para FORA da nossa origem, que é o ponto do desenho.
  await page.route('**/api/acervo/upload', async (route) => {
    if (!logado) return route.fulfill({ status: 401, json: { error: 'sessão expirada' } });
    const { bytes } = JSON.parse(route.request().postData() ?? '{}');
    if (bytes > 60 * 1024 * 1024) {
      return route.fulfill({
        status: 413,
        json: { error: 'arquivo grande demais: o limite é 60 MB' },
      });
    }
    return route.fulfill({
      status: 200,
      json: {
        id: 'envio-1',
        url: 'https://bucket.falso/ondas-acervo/stage/u/envio-1.bin',
        expiraEmS: 900,
        maxBytes: 60 * 1024 * 1024,
      },
    });
  });

  await page.route('https://bucket.falso/**', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    enviosRecebidos += 1;
    return route.fulfill({ status: 200, body: '' });
  });

  // 2) o finalizar: enfileira a MESMA ingestão da fase 2.
  await page.route('**/api/acervo/upload/*/finalizar', async (route) => {
    const { nome } = JSON.parse(route.request().postData() ?? '{}');
    // O arquivo tem de ter chegado ao bucket ANTES de finalizar.
    if (enviosRecebidos === 0) {
      return route.fulfill({ status: 404, json: { error: 'o arquivo não chegou ao bucket' } });
    }
    acervo.push({
      id: 'acervo:22222222-2222-4222-8222-222222222222',
      title: String(nome || 'sem título'),
      artist: 'acervo',
      genre: 'acervo',
      dur: 7,
      art: '',
      stream: '/api/acervo/22222222-2222-4222-8222-222222222222/audio',
      // O worker mede a forma de onda na ingestão, então faixa recém-chegada
      // vem com ela — é o que o stub imita.
      peaks: PICOS_METADE,
      premium: false,
    });
    return route.fulfill({ status: 202, json: { id: 'job-1', status: 'pending', url: 'upload:envio-1' } });
  });

  // 3) o acompanhamento, igual ao da ingestão por URL.
  await page.route('**/api/acervo/ingest/*', async (route) =>
    route.fulfill({
      status: 200,
      json: {
        id: 'job-1',
        status: 'ready',
        url: 'upload:envio-1',
        trackId: 'acervo:22222222-2222-4222-8222-222222222222',
      },
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await blockAudius(page);
  await stubApi(page);
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

/**
 * Abre `ondas whoami`. Há duas portas com o mesmo nome acessível — o nome no
 * prompt e o do rodapé —, e `first()` pega a de cima; `qual: 'rodape'` pega a
 * outra. As duas abrem o mesmo overlay, e os testes checam as duas.
 */
async function abrirConta(page: Page, qual: 'prompt' | 'rodape' = 'prompt') {
  const portas = page.getByRole('button', { name: 'Conta e aparelho' });
  await (qual === 'prompt' ? portas.first() : portas.last()).click();
  await expect(page).toHaveURL(/account=1/);
  await expect(page.getByRole('dialog', { name: 'ondas whoami' })).toBeVisible();
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

  // Full player é a rota da faixa — o mesmo endereço que o botão de
  // compartilhar entrega —, e o voltar o fecha.
  await page.getByRole('button', { name: 'Abrir player' }).click();
  await expect(page).toHaveURL(LINK_DEMO);
  await expect(page.getByRole('heading', { name: 'Maré Baixa' })).toBeVisible();
  await expect(page.getByText('agora-tocando — #ambient')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Maré Baixa' })).toBeHidden();
});

test('o player esconde os atalhos no estreito e mantém as ações numa linha', async ({ page }) => {
  await page.goto('/login');
  await skipSplash(page);
  await page.getByRole('button', { name: /continuar como visitante/ }).click();
  await page.getByRole('button', { name: /Maré Baixa/ }).click();
  await page.getByRole('button', { name: 'Abrir player' }).click();
  await expect(page.getByRole('heading', { name: 'Maré Baixa' })).toBeVisible();

  // O mesmo breakpoint do `useWide`: no celular não há teclado, então a letra
  // da tecla e os `[esc]`/`[d]` são ruído.
  const largo = page.viewportSize()!.width >= 860;

  const letras = page.locator('[class*="keycapKey"]');
  await expect(letras).toHaveCount(largo ? 8 : 0);

  const painel = page.locator('[class*="overlay_panel"], [class*="panel"]').first();
  const texto = (await painel.innerText()).replace(/\s+/g, ' ');
  if (largo) {
    expect(texto).toContain('[esc] fechar');
  } else {
    expect(texto).not.toMatch(/\[(esc|d)\]/);
  }

  // As oito ações numa fileira só — e dentro da caixa, sem transbordar.
  const caixas = await page.locator('[class*="keycaps"] > button').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { topo: Math.round(r.top), direita: Math.round(r.right) };
    }),
  );
  expect(caixas).toHaveLength(8);
  expect(new Set(caixas.map((c) => c.topo)).size).toBe(1);

  const limite = await page
    .locator('[class*="keycaps"]')
    .first()
    .evaluate((el) => Math.round(el.getBoundingClientRect().right));
  for (const c of caixas) expect(c.direita).toBeLessThanOrEqual(limite);
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

test('login libera o catálogo, e a conta sai da biblioteca para `ondas whoami`', async ({
  page,
}) => {
  await page.goto('/login');
  await skipSplash(page);
  await page.getByPlaceholder('voce@email.com').fill('thiago@ondas.app');
  // 8+ caracteres: a régua é do servidor agora (argon2id), não mais do protótipo.
  await page.getByPlaceholder('••••').fill('senha-forte');
  await page.getByRole('button', { name: /entrar — catálogo completo/ }).click();

  await expect(page.getByText(/autenticado como thiago/)).toBeVisible();
  await expect(page.getByText('@thiago')).toBeVisible();
  await expect(page.getByText(/sessão de visitante/)).toBeHidden();

  // Atalho `3` abre a biblioteca.
  await page.keyboard.press('3');
  await expect(page).toHaveURL(/library/);
  await expect(page.getByText('vazio — pressione [l] ou o coração para curtir.')).toBeVisible();
  // A biblioteca é só biblioteca: plano e ocupação não moram mais nela.
  await expect(page.getByText('catálogo completo + offline')).toBeHidden();
  await expect(page.getByText('0 faixas · 0.0 MB')).toBeHidden();

  // Eles moram atrás do próprio nome — aqui o do prompt, no alto.
  await abrirConta(page);
  const conta = page.getByRole('dialog', { name: 'ondas whoami' });
  await expect(conta.getByText('catálogo completo + offline')).toBeVisible();
  await expect(conta.getByText('0 faixas · 0.0 MB')).toBeVisible();

  // Esc fecha uma camada e devolve o endereço.
  await page.keyboard.press('Escape');
  await expect(conta).toBeHidden();
  await expect(page).not.toHaveURL(/account=1/);
});

test('o acervo aparece só logado, marcado como [meu], e some ao sair', async ({ page }) => {
  // A linha da lista é um botão cujo nome acessível traz índice, título,
  // artista e gênero. Usar isso em vez de getByText evita casar com o título
  // que a barra de baixo mostra da faixa atual.
  const linha = (titulo: string) => page.getByRole('button', { name: new RegExp(titulo) });

  await page.goto('/login');
  await skipSplash(page);

  // Visitante: nada do acervo, e a fonte é só a pública.
  await page.getByRole('button', { name: /continuar como visitante/ }).click();
  await expect(page.getByText(/catálogo demo/)).toBeVisible();
  await expect(linha('Fita Caseira')).toBeHidden();
  await expect(page.getByText(/\+ acervo/)).toBeHidden();

  // Entrando, as faixas próprias entram na frente da lista.
  await page.goto('/login');
  await skipSplash(page);
  await page.getByPlaceholder('voce@email.com').fill('thiago@ondas.app');
  await page.getByPlaceholder('••••').fill('senha-forte');
  await page.getByRole('button', { name: /entrar — catálogo completo/ }).click();

  // `^01` prova que é a PRIMEIRA da lista, não só que está nela.
  await expect(page.getByRole('button', { name: /^01 Fita Caseira/ })).toBeVisible();
  // O selo [meu] só existe no largo; no estreito a lista é enxuta.
  if (page.viewportSize()!.width >= 860) {
    await expect(page.getByText('[meu]')).toBeVisible();
  } else {
    await expect(page.getByText('[meu]')).toBeHidden();
  }
  // A linha do prompt passa a admitir as duas fontes.
  await expect(page.getByText(/\+ acervo \(1\)/)).toBeVisible();

  // O gênero `acervo` vira filtro próprio, de graça. O chip selecionado vem
  // entre colchetes, daí o exact para não casar com a linha da faixa.
  await page.getByRole('button', { name: 'acervo', exact: true }).click();
  await expect(linha('Fita Caseira')).toBeVisible();
  await expect(linha('Maré Baixa')).toBeHidden();
  await page.getByRole('button', { name: 'tudo', exact: true }).click();
  await expect(linha('Maré Baixa')).toBeVisible();

  // Saindo, o acervo some — e o selo [meu] com ele. `[sair]` agora vive em
  // `ondas whoami`, não na biblioteca.
  await abrirConta(page);
  await page.getByRole('button', { name: '[sair]' }).click();
  await expect(page).toHaveURL(/login/);

  // De volta ao app como visitante: é AQUI que a ausência do acervo vale,
  // não na tela de login, onde lista nenhuma existe.
  await page.getByRole('button', { name: /continuar como visitante/ }).click();
  await expect(linha('Maré Baixa')).toBeVisible();
  await expect(linha('Fita Caseira')).toBeHidden();
  await expect(page.getByText('[meu]')).toBeHidden();
  await expect(page.getByText(/\+ acervo/)).toBeHidden();
});

test('conta e aparelho: as duas portas, o buffer e limpar downloads', async ({ page }) => {
  await page.goto('/login');
  await skipSplash(page);
  await page.getByPlaceholder('voce@email.com').fill('thiago@ondas.app');
  await page.getByPlaceholder('••••').fill('senha-forte');
  await page.getByRole('button', { name: /entrar — catálogo completo/ }).click();
  await expect(page.getByRole('button', { name: /^01 Fita Caseira/ })).toBeVisible();

  // ── a porta de baixo: o próprio nome na status line ──────────────
  await abrirConta(page, 'rodape');
  const conta = page.getByRole('dialog', { name: 'ondas whoami' });

  // `buffer` é preferência do aparelho, e o botão carrega o próprio estado.
  // Fica DESLIGADO no resto do teste de propósito: ligado, tocar uma faixa
  // manda a próxima para o aparelho sozinho, e a contagem abaixo viraria uma
  // corrida entre o download pedido e o que o buffer trouxe sem pedir.
  const buffer = conta.getByRole('button', { name: /buffer/ });
  await expect(buffer).toHaveAttribute('aria-pressed', 'true');
  await buffer.click();
  await expect(buffer).toHaveAttribute('aria-pressed', 'false');

  // Sem nada no aparelho não há o que limpar — botão que não faz nada é ruído.
  await expect(conta.getByText('0 faixas · 0.0 MB')).toBeVisible();
  await expect(conta.getByRole('button', { name: '[limpar downloads]' })).toBeHidden();
  await page.keyboard.press('Escape');

  // ── baixa uma faixa, para haver o que limpar ─────────────────────
  await page.getByRole('button', { name: /^01 Fita Caseira/ }).click();
  await page.keyboard.press('d');
  await expect(page.getByText('salva no aparelho')).toBeVisible();

  // Os bytes estão mesmo lá, não só o índice.
  const noCache = () =>
    page.evaluate(async () => (await (await caches.open('ondas-offline')).keys()).length);
  expect(await noCache()).toBe(1);

  // ── e aí sim, em dois toques ─────────────────────────────────────
  await abrirConta(page);
  await expect(conta.getByText(/^1 faixa · \d+\.\d MB$/)).toBeVisible();
  await conta.getByRole('button', { name: '[limpar downloads]' }).click();
  // O primeiro toque só pergunta: apagar não dá para desfazer.
  await expect(conta.getByText('apagar 1?')).toBeVisible();
  await expect(conta.getByText(/^1 faixa ·/)).toBeVisible();
  await conta.getByRole('button', { name: '[sim]' }).click();
  await expect(conta.getByText('0 faixas · 0.0 MB')).toBeVisible();
  // E os bytes foram embora de verdade: zerar só o índice deixaria os
  // megabytes no aparelho com o painel jurando que não há nada.
  await expect.poll(noCache).toBe(0);
  await page.keyboard.press('Escape');

  // O segmento `--offline` concorda com o painel: o índice foi reconciliado
  // com o cache, não só zerado na mão.
  await page.keyboard.press('3');
  await page.getByRole('button', { name: '--offline' }).click();
  await expect(page.getByText(/vazio — baixe faixas/)).toBeVisible();
});

test('visitante também tem `ondas whoami`, com [entrar] no lugar de [sair]', async ({ page }) => {
  await page.goto('/login');
  await skipSplash(page);
  await page.getByRole('button', { name: /continuar como visitante/ }).click();

  await abrirConta(page, 'rodape');
  const conta = page.getByRole('dialog', { name: 'ondas whoami' });
  await expect(conta.getByText('visitante')).toBeVisible();
  await expect(conta.getByText('somente faixas grátis')).toBeVisible();
  // Sem conta não há de onde sair — e o painel vira o caminho para entrar.
  await expect(conta.getByRole('button', { name: '[sair]' })).toBeHidden();
  await conta.getByRole('button', { name: '[entrar]' }).click();
  await expect(page).toHaveURL(/login/);
});

test('enviar arquivo sobe para o bucket, processa e a faixa entra no acervo', async ({ page }) => {
  // Clicar na aba em vez de mandar a tecla: a tecla é um atalho do shell do
  // app, e logo depois do login ela pode chegar antes do shell montar — a
  // primeira versão deste teste fazia isso e era intermitente (passava aqui,
  // falhava no CI, que é mais lento). Clique o Playwright espera; tecla não.
  const aba = (nome: RegExp) => page.getByRole('button', { name: nome });

  await page.goto('/login');
  await skipSplash(page);

  // Visitante não tem para onde enviar: o acervo é por conta.
  await page.getByRole('button', { name: /continuar como visitante/ }).click();
  await aba(/~\/biblioteca/).click();
  await expect(page.getByText('enviar', { exact: true })).toBeHidden();
  // O chip `--acervo` some junto, pelo mesmo motivo: sem conta o catálogo não
  // traz faixa própria nenhuma, e ele seria uma lista sempre vazia.
  await expect(page.getByRole('button', { name: '--acervo' })).toBeHidden();

  await page.goto('/login');
  await skipSplash(page);
  await page.getByPlaceholder('voce@email.com').fill('thiago@ondas.app');
  await page.getByPlaceholder('••••').fill('senha-forte');
  await page.getByRole('button', { name: /entrar — catálogo completo/ }).click();
  await aba(/~\/biblioteca/).click();

  await expect(page.getByText('enviar', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '[+ arquivo]' }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'Noite_Fria.mp3',
    mimeType: 'audio/mpeg',
    buffer: Buffer.from('nao e um mp3 de verdade, o stub nao examina'),
  });

  // O nome aparece limpo (sem extensão, sem underscore) e o envio conclui.
  await expect(page.getByText('Noite Fria', { exact: true })).toBeVisible();
  await expect(page.getByText('pronto', { exact: true })).toBeVisible();

  // E a faixa entrou no catálogo — que foi relido por causa da ingestão. Os
  // chips de gênero e a contagem da fonte moram na aba `em-alta`, não aqui.
  await aba(/~\/em-alta/).click();
  await expect(page.getByText(/\+ acervo \(2\)/)).toBeVisible();
  await page.getByRole('button', { name: 'acervo', exact: true }).click();
  await expect(page.getByRole('button', { name: /Noite Fria/ })).toBeVisible();

  // Dispensar a linha concluída do painel não mexe na faixa.
  await aba(/~\/biblioteca/).click();
  await page.getByRole('button', { name: 'dispensar Noite Fria' }).click();
  await expect(page.getByText('pronto', { exact: true })).toBeHidden();

  // E a biblioteca sabe mostrar o acervo: o segmento vai pela procedência da
  // faixa, não por curtida nem download — `--curtidas` continua vazia.
  await expect(page.getByText(/vazio — pressione \[l\]/)).toBeVisible();
  await page.getByRole('button', { name: '--acervo' }).click();
  // O chip fala português e o endereço fala inglês, de propósito: o id do
  // recorte é o mesmo `source` que a API emite, e só a palavra da URL muda.
  await expect(page).toHaveURL('/library/archive');
  await expect(page.getByRole('button', { name: /Noite Fria/ })).toBeVisible();

  await aba(/~\/em-alta/).click();
  await expect(page.getByRole('button', { name: /Noite Fria/ })).toBeVisible();
});

/** `{ rola, capa }` do player cheio: se precisa rolar, e quanto mede a capa. */
async function medirPlayer(page: Page) {
  return page.evaluate(() => {
    const tela = document.querySelector('[class*="fullscreen"]') as HTMLElement;
    const capa = document.querySelector(
      '[class*="cover"]:not([class*="coverBox"]):not([class*="coverLogo"])',
    ) as HTMLElement;
    const r = capa.getBoundingClientRect();
    return {
      // 1px de folga: zoom de dispositivo deixa sobras fracionárias.
      rola: tela.scrollHeight > tela.clientHeight + 1,
      largura: Math.round(r.width),
      altura: Math.round(r.height),
    };
  });
}

test('o player cabe na tela sem rolar, e a capa continua quadrada', async ({ page }) => {
  await page.goto('/login');
  await skipSplash(page);
  await page.getByPlaceholder('voce@email.com').fill('thiago@ondas.app');
  await page.getByPlaceholder('••••').fill('senha-forte');
  await page.getByRole('button', { name: /entrar — catálogo completo/ }).click();
  await page.getByRole('button', { name: /^01 Fita Caseira/ }).click();
  await page.getByRole('button', { name: 'Abrir player' }).click();
  await expect(page.getByRole('heading', { name: 'Fita Caseira' })).toBeVisible();

  // Rolar para ver os botões de tocar é perder o player. Quem se ajusta é a
  // capa, que fica com a altura que sobrar — e tem de continuar quadrada,
  // senão `object-fit: cover` corta a arte.
  const telas = [
    { width: 360, height: 640 }, // o aperto: quase não sobra altura
    { width: 414, height: 896 }, // sobra MAIS altura do que largura
    { width: 393, height: 727 },
  ];
  for (const t of telas) {
    await page.setViewportSize(t);
    const onde = `${t.width}x${t.height}`;
    await expect.poll(async () => (await medirPlayer(page)).rola, { message: onde }).toBe(false);
    const m = await medirPlayer(page);
    expect(Math.abs(m.largura - m.altura), onde).toBeLessThanOrEqual(1);
    expect(m.altura, onde).toBeGreaterThan(120);
  }
});

test('toque longo: casca não seleciona, o que se copia continua copiável', async ({ page }) => {
  await page.goto('/login');
  await skipSplash(page);

  // O campo de senha é o caso que quebra quando se desliga seleção na raiz.
  const selecao = (loc: ReturnType<Page['locator']>) =>
    loc.evaluate((el) => {
      const c = getComputedStyle(el);
      return [c.userSelect, c.webkitUserSelect].find(Boolean) ?? '';
    });
  expect(await selecao(page.getByPlaceholder('••••'))).toBe('text');

  await page.getByPlaceholder('voce@email.com').fill('thiago@ondas.app');
  await page.getByPlaceholder('••••').fill('senha-forte');
  await page.getByRole('button', { name: /entrar — catálogo completo/ }).click();
  const linha = page.getByRole('button', { name: /^01 Fita Caseira/ });
  await expect(linha).toBeVisible();

  // Linha da lista é alvo de toque: segurar nela não pode virar seleção.
  expect(await selecao(linha)).toBe('none');

  await linha.click();
  await page.getByRole('button', { name: 'Abrir player' }).click();
  await expect(page.getByRole('heading', { name: 'Fita Caseira' })).toBeVisible();

  // Título e artista são o texto que alguém leva embora: continuam
  // selecionáveis — e com callout, senão no iOS dá para marcar sem copiar.
  expect(await selecao(page.getByRole('heading', { name: 'Fita Caseira' }))).toBe('text');

  // A capa sai do caminho do ponteiro: é o que tira o "Baixar imagem" do
  // toque longo no Android, sem precisar bloquear `contextmenu` no JS (o que
  // mataria o clique direito no desktop).
  const capa = page.locator('.ondas-art').first();
  await expect(capa).toBeVisible();
  expect(await capa.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
});

/** Entra com a conta de teste e deixa a primeira faixa do acervo tocando. */
async function logarEtocarAcervo(page: Page) {
  await page.goto('/login');
  await skipSplash(page);
  await page.getByPlaceholder('voce@email.com').fill('thiago@ondas.app');
  await page.getByPlaceholder('••••').fill('senha-forte');
  await page.getByRole('button', { name: /entrar — catálogo completo/ }).click();
  const linha = page.getByRole('button', { name: /^01 Fita Caseira/ });
  await expect(linha).toBeVisible({ timeout: 30000 });
  await linha.click();
}

test('baixar não faz o arquivo inteiro passar pela memória', async ({ page }) => {
  const grande = wavDeSilencio(240); // ~3,8 MB
  await page.route('**/api/acervo/*/audio', async (route) =>
    route.fulfill({ status: 200, contentType: 'audio/wav', body: grande }),
  );
  // Espiã no construtor de `Blob`: com a gravação em fluxo, nenhum pedaço
  // grande do arquivo chega a existir como objeto em memória. Foi esta mesma
  // sonda que mostrou o problema — 54,9 MB de arquivo viravam um Blob de
  // 54,9 MB.
  await page.addInitScript(() => {
    const Orig = window.Blob;
    (window as unknown as { __blobs: number[] }).__blobs = [];
    function Espia(this: unknown, partes: BlobPart[] = [], op?: BlobPropertyBag) {
      let total = 0;
      for (const p of partes) {
        total += (p as ArrayBufferView).byteLength ?? (p as Blob).size ?? 0;
      }
      (window as unknown as { __blobs: number[] }).__blobs.push(total);
      return new Orig(partes, op);
    }
    Espia.prototype = Orig.prototype;
    (window as unknown as { Blob: unknown }).Blob = Espia;
  });

  await logarEtocarAcervo(page);
  await page.keyboard.press('d');
  await expect
    .poll(
      () => page.evaluate(async () => (await (await caches.open('ondas-offline')).keys()).length),
      { timeout: 60000 },
    )
    .toBe(1);

  const maior = await page.evaluate(() =>
    Math.max(0, ...(window as unknown as { __blobs: number[] }).__blobs),
  );
  expect(maior, `maior Blob construído, em bytes (arquivo tem ${grande.length})`).toBeLessThan(
    1048576,
  );
});

test('sem espaço no aparelho avisa diferente de sem rede', async ({ page }) => {
  // A cota estourando é um `QuotaExceededError` vindo do `cache.put`.
  await page.addInitScript(() => {
    Cache.prototype.put = () => {
      const e = new Error('simulado');
      e.name = 'QuotaExceededError';
      return Promise.reject(e);
    };
  });

  await logarEtocarAcervo(page);
  await page.keyboard.press('d');

  // A frase tem de dizer o que fazer. "falha no download" mandava a pessoa
  // tentar de novo contra um telefone cheio.
  await expect(page.getByText(/sem espaço no aparelho/)).toBeVisible();
  await expect(page.getByText('falha no download')).toBeHidden();
  // E nada ficou marcado como baixado.
  await expect(page.getByText('[off]')).toBeHidden();
});

test('o painel mostra quanto espaço ainda cabe', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: async () => ({ usage: 1.2 * 1073741824, quota: 4.2 * 1073741824 }),
        persist: async () => true,
        persisted: async () => true,
      },
    });
  });

  await page.goto('/login');
  await skipSplash(page);
  await page.getByRole('button', { name: /continuar como visitante/ }).click();
  await abrirConta(page, 'rodape');

  // O número que decide se cabe o mix de uma hora é o que SOBRA, não o usado.
  await expect(
    page.getByRole('dialog', { name: 'ondas whoami' }).getByText('3.0 GB livres de 4.2 GB'),
  ).toBeVisible();
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

test('coluna central no desktop com faixas de ponta a ponta', async ({ page }) => {
  await page.goto('/login');
  await skipSplash(page);
  await page.getByRole('button', { name: /continuar como visitante/ }).click();
  await page.getByRole('button', { name: /Maré Baixa/ }).click();

  const largura = page.viewportSize()!.width;
  const coluna = Math.min(1080, largura);

  // A barra de abas é a faixa; o que está dentro dela é a coluna.
  const abas = page.getByRole('button', { name: '~/em-alta' });
  const medidas = await abas.evaluate((el) => {
    const inner = el.parentElement!.getBoundingClientRect();
    const band = el.parentElement!.parentElement!.getBoundingClientRect();
    return { inner: Math.round(inner.width), band: Math.round(band.width) };
  });
  expect(medidas.band).toBe(largura);
  expect(medidas.inner).toBe(coluna);

  // Conteúdo e linha do player seguem a mesma coluna.
  for (const alvo of [page.locator('main > div').first(), page.getByText('PLAY', { exact: true })]) {
    const box = (await alvo.boundingBox())!;
    expect(Math.round(box.width)).toBeLessThanOrEqual(coluna);
  }
});

test('transparência do fundo liga pelo painel de temas e volta ao opaco', async ({ page }) => {
  await page.goto('/login');
  await skipSplash(page);
  await page.getByRole('button', { name: /continuar como visitante/ }).click();

  const wallpaper = page.locator('div[aria-hidden="true"][style*="blur("]');
  const bgA = () =>
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-bg-a').trim());

  // Padrão opaco: nada de wallpaper no DOM.
  await expect(wallpaper).toHaveCount(0);
  expect(await bgA()).toContain('100%');

  await page.getByRole('button', { name: 'Trocar tema' }).click();
  const slider = page.getByLabel('background-opacity');
  const trilha = (await slider.boundingBox())!;
  await page.mouse.click(trilha.x + trilha.width * 0.4, trilha.y + trilha.height / 2);

  await expect(wallpaper).toHaveCount(1);
  expect(await bgA()).not.toContain('100%');
  // As rampas que carregam texto e borda continuam opacas.
  const neutral = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-neutral-500'),
  );
  expect(neutral).not.toContain('transparent');

  // De volta ao fim da trilha: opaco de novo, sem wallpaper.
  await page.mouse.click(trilha.x + trilha.width - 2, trilha.y + trilha.height / 2);
  await expect(wallpaper).toHaveCount(0);
  expect(await bgA()).toContain('100%');
});

test('status line mantém os itens na mesma linha de base', async ({ page }) => {
  await page.goto('/login');
  await skipSplash(page);
  await page.getByRole('button', { name: /continuar como visitante/ }).click();

  // Mede o texto, não a caixa: o indicador de rede tem altura própria por causa
  // da área de toque, e era isso que o deixava ~6px acima dos vizinhos.
  const topos = await page.evaluate(() => {
    const linha = document.querySelector('[class*="statusInner"]')!;
    return [...linha.children]
      .filter((el) => el.textContent?.trim())
      .map((el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        return Math.round(r.getBoundingClientRect().top);
      });
  });
  expect(topos.length).toBeGreaterThan(1);
  expect(new Set(topos).size).toBe(1);
});

test('a lista de formatos do envio não quebra no meio', async ({ page }) => {
  await page.goto('/login');
  await skipSplash(page);
  await page.getByPlaceholder('voce@email.com').fill('thiago@ondas.app');
  await page.getByPlaceholder('••••').fill('senha-forte');
  await page.getByRole('button', { name: /entrar — catálogo completo/ }).click();
  await page.getByRole('button', { name: /~\/biblioteca/ }).click();
  await expect(page.getByText('enviar', { exact: true })).toBeVisible();

  // No celular ela quebrava entre "opus" e "m4a", e o separador ficava órfão
  // no começo da linha de baixo. O Range conta as linhas que o texto ocupa de
  // verdade — `getClientRects` devolve uma caixa por linha.
  const medida = await page.locator('[class*="panelFormatos"]').evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const linha = el.parentElement!.getBoundingClientRect();
    return {
      linhas: r.getClientRects().length,
      direita: Math.round(el.getBoundingClientRect().right),
      limite: Math.round(linha.right),
    };
  });
  expect(medida.linhas).toBe(1);
  expect(medida.direita).toBeLessThanOrEqual(medida.limite);
});

test('as abas: rótulo inteiro no largo, só ícone no estreito', async ({ page }) => {
  await page.goto('/login');
  await skipSplash(page);
  await page.getByRole('button', { name: /continuar como visitante/ }).click();

  // As abas são as únicas da barra cujo nome é um caminho. No largo ele está no
  // texto; no estreito, onde só há ícone, só no `aria-label`.
  const abas = await page.evaluate(() =>
    [...document.querySelectorAll('[class*="tabbarInner"] button')]
      .filter((el) => `${el.textContent} ${el.getAttribute('aria-label') ?? ''}`.includes('~/'))
      .map((el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        const caixa = el.getBoundingClientRect();
        return {
          texto: Math.round(r.getBoundingClientRect().width),
          largura: Math.round(caixa.width),
          altura: Math.round(caixa.height),
          escrito: el.textContent!.trim(),
          icones: el.querySelectorAll('svg').length,
        };
      }),
  );
  expect(abas).toHaveLength(3);

  if (page.viewportSize()!.width >= 860) {
    // O que este teste guardava antes: no largo o rótulo não pode ser cortado.
    for (const aba of abas) expect(aba.texto).toBeLessThanOrEqual(aba.largura);
    return;
  }

  // No estreito a aba não tem texto nenhum — o nome dela é lido na linha do
  // prompt, logo abaixo, que é o que torna a troca indolor. Cada uma vira um
  // alvo de dedo de 44px.
  for (const aba of abas) {
    expect(aba.escrito).toBe('');
    expect(aba.icones).toBe(1);
    expect(aba.altura).toBeGreaterThanOrEqual(44);
    expect(aba.largura).toBeGreaterThanOrEqual(44);
  }
  await expect(page.getByText('~/em-alta')).toBeVisible();

  // E tomam a barra inteira: o espaçador tem o mesmo `flex: 1` das abas e, se
  // for renderizado aqui, abre uma quarta coluna vazia antes do botão de tema.
  const vao = await page.evaluate(() => {
    const barra = document.querySelector('[class*="tabbarInner"]')!;
    const botoes = [...barra.querySelectorAll('button')];
    const tema = botoes[botoes.length - 1]!.getBoundingClientRect();
    const ultima = botoes[botoes.length - 2]!.getBoundingClientRect();
    return Math.round(tema.left - ultima.right);
  });
  expect(vao).toBe(0);
});

/**
 * Alturas das barras da forma de onda, da esquerda para a direita.
 *
 * O desenho é feito de três `<path>` — tocado, em buffer e resto — então as
 * barras só ficam em ordem depois de reunir os três e ordenar por x. O `:scope
 * > path` deixa o reflexo de fora: ele vive num `<g>`.
 */
async function alturasDaOnda(page: Page, dentroDe: string): Promise<number[]> {
  return page.evaluate((seletor) => {
    const svg = document.querySelector(`${seletor} [role="slider"] svg`);
    if (!svg) throw new Error(`nenhuma forma de onda em ${seletor}`);
    const pares: [number, number][] = [];
    for (const p of svg.querySelectorAll(':scope > path')) {
      for (const m of (p.getAttribute('d') ?? '').matchAll(/M([\d.]+),([\d.]+)V([\d.]+)/g)) {
        pares.push([Number(m[1]), Number(m[2]) - Number(m[3])]);
      }
    }
    return pares.sort((a, b) => a[0] - b[0]).map(([, altura]) => altura);
  }, dentroDe);
}

test('a forma de onda desenha o áudio quando ele é conhecido, e barra lisa quando não', async ({
  page,
}) => {
  await page.goto('/login');
  await skipSplash(page);

  // ── catálogo público: ninguém mediu esse áudio ──────────────────
  await page.getByRole('button', { name: /continuar como visitante/ }).click();
  await page.getByRole('button', { name: /Maré Baixa/ }).click();
  await page.getByRole('button', { name: 'Abrir player' }).click();
  await expect(page.getByRole('heading', { name: 'Maré Baixa' })).toBeVisible();

  const lisa = await alturasDaOnda(page, '[class*="waveBlock"]');
  expect(lisa.length).toBeGreaterThan(40);
  // Lisa de verdade: uma altura só. Se um dia voltar a inventar relevo para
  // faixa sem picos, este conjunto deixa de ter um elemento.
  expect(new Set(lisa.map((h) => h.toFixed(1))).size).toBe(1);

  // ── e o teclado alcança a barra, que antes era um span sem foco ──
  // Pausado: com a faixa correndo, mandar o cursor para o fim dispara o fim
  // da faixa e o player pula para a próxima no meio das asserções. Pelo
  // atalho, e não pelo botão: o overlay cobre o do rodapé.
  await page.keyboard.press(' ');
  await expect(page.getByRole('button', { name: 'Tocar' }).first()).toBeVisible();

  const barra = page.getByRole('slider', { name: 'Posição da faixa' }).first();
  await barra.focus();
  await expect(barra).toHaveAttribute('aria-valuenow', '0');
  // Uma tecla só: duas seguidas leem a mesma posição antes do re-render e o
  // teste viraria uma corrida.
  await page.keyboard.press('ArrowRight');
  await expect(barra).toHaveAttribute('aria-valuenow', '2');
  await page.keyboard.press('Home');
  await expect(barra).toHaveAttribute('aria-valuenow', '0');
  await page.keyboard.press('End');
  await expect(barra).toHaveAttribute('aria-valuenow', '100');

  // Espaço com o foco na barra toca/pausa — não salta a faixa para o começo.
  // A barra é um <button>, e clique de teclado chega sem coordenada.
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press(' ');
  await expect(barra).toHaveAttribute('aria-valuenow', '2');

  // ── arrastar: o ponto é escolhido com o botão apertado, e a faixa só
  //    anda ao soltar ────────────────────────────────────────────────
  // O espaço acima voltou a tocar; pausar de novo para que o tempo exibido
  // só mude por causa do arrasto.
  await page.keyboard.press(' ');
  await expect(page.getByRole('button', { name: 'Tocar' }).first()).toBeVisible();
  await page.keyboard.press('Home');
  await expect(page.locator('[class*="timeNow"]')).toHaveText('0:00');

  // A do player cheio, e não `barra`: aquela é a do rodapé, que está por
  // baixo do overlay. O teclado alcança um elemento coberto; o mouse não.
  const grande = page.locator('[class*="waveBlock"] [role="slider"]');
  const caixa = (await grande.boundingBox())!;
  const emX = (f: number) => caixa.x + caixa.width * f;
  const meio = caixa.y + caixa.height / 2;
  const valor = async () => Number(await grande.getAttribute('aria-valuenow'));

  await page.mouse.move(emX(0.2), meio);
  await page.mouse.down();
  await page.mouse.move(emX(0.7), meio, { steps: 12 });

  // Ainda apertado: a barra já mostra o destino (sem isto não há arrasto,
  // só clique)…
  await expect.poll(valor).toBeGreaterThan(65);
  expect(await valor()).toBeLessThan(75);
  // …e o áudio não saiu do lugar. Procurar a cada movimento é o que faz uma
  // faixa que vem pela rede engasgar a cada pixel arrastado.
  await expect(page.locator('[class*="timeNow"]')).toHaveText('0:00');

  // O realce de toque do Chrome no Android pinta a caixa INTEIRA do botão —
  // sobre a forma de onda isso é um retângulo cinza cobrindo o desenho todo.
  // E sem `pan-y` o navegador leva o arrasto horizontal como rolagem e
  // cancela o gesto no meio. São duas linhas de CSS que somem sem alarde.
  expect(
    await grande.evaluate((el) => {
      const c = getComputedStyle(el);
      return [c.getPropertyValue('-webkit-tap-highlight-color'), c.touchAction];
    }),
  ).toEqual(['rgba(0, 0, 0, 0)', 'pan-y']);

  await page.mouse.up();
  // Soltou: agora sim. A faixa tem 3:34, então 70% caem nos 2 e pouco — bem
  // longe tanto do 0:00 de antes quanto do 0:42 de onde o botão foi apertado.
  await expect(page.locator('[class*="timeNow"]')).toHaveText(/^2:\d\d$/);
  expect(await valor()).toBeGreaterThan(65);

  // ── acervo: o worker mediu, então a barra tem relevo ────────────
  await page.goto('/login');
  await skipSplash(page);
  await page.getByPlaceholder('voce@email.com').fill('thiago@ondas.app');
  await page.getByPlaceholder('••••').fill('senha-forte');
  await page.getByRole('button', { name: /entrar — catálogo completo/ }).click();

  await page.getByRole('button', { name: /^01 Fita Caseira/ }).click();
  await page.getByRole('button', { name: 'Abrir player' }).click();
  await expect(page.getByRole('heading', { name: 'Fita Caseira' })).toBeVisible();

  // A fixture é metade no teto, metade em silêncio: a barra mais baixa da
  // primeira metade tem de superar com folga a mais alta da segunda. As
  // barras da fronteira ficam de fora — elas resumem um trecho que tem os
  // dois volumes.
  const metadeAMetade = (alturas: number[]) => {
    const meio = Math.floor(alturas.length / 2);
    return {
      menorNoComeco: Math.min(...alturas.slice(0, meio - 1)),
      maiorNoFim: Math.max(...alturas.slice(meio + 1)),
    };
  };

  const real = await alturasDaOnda(page, '[class*="waveBlock"]');
  const cheio = metadeAMetade(real);
  expect(cheio.menorNoComeco).toBeGreaterThan(cheio.maiorNoFim * 10);

  // O rodapé desenha a MESMA faixa, não um enfeite à parte.
  const rodape = await alturasDaOnda(page, '[class*="progress"]');
  expect(rodape.length).toBeGreaterThan(20);
  const pequeno = metadeAMetade(rodape);
  expect(pequeno.menorNoComeco).toBeGreaterThan(pequeno.maiorNoFim * 10);
});

test('link de faixa abre a música sem passar pelo login', async ({ page }) => {
  // O bloqueio não é detalhe: o teste afirma faixas do catálogo demo, que só
  // entra quando a API do Audius está fora do alcance.
  await blockAudius(page);
  await page.goto(LINK_DEMO);
  await skipSplash(page);

  // O ponto do deeplink: quem recebeu o link não vê tela de login.
  await expect(page.getByText('ondas — login')).toBeHidden();
  await expect(page.getByText(/sessão de visitante/)).toBeVisible();

  // O player cheio abre já na faixa certa, e o endereço continua sendo o do
  // link: ele não ganha param nenhum para dizer que está aberto.
  await expect(page).toHaveURL(LINK_DEMO);
  await expect(page.getByRole('heading', { name: 'Maré Baixa' })).toBeVisible();
  await expect(page.getByText('Maré Baixa — Lia Sombra')).toBeVisible();
  // Nada de afirmar PLAY/PAUSE: a política de autoplay do Chromium decide
  // isso, e o link promete carregar a faixa, não tocá-la sozinha.

  // Fechando o player, quem chegou pelo link já está no app — sem tela morta.
  // Sem tela de origem no histórico (o link veio de fora), fechar cai no
  // em-alta em vez de sair do app.
  await page.getByRole('button', { name: /fechar/ }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByText('Concreto Molhado')).toBeVisible();
});

test('link quebrado e link de faixa privada não contam nada', async ({ page }) => {
  await blockAudius(page);
  await page.goto('/t/nada-ZZZZZZZZ');
  await skipSplash(page);
  await expect(page.getByText(/faixa não encontrada/)).toBeVisible();

  // Faixa do acervo sem sessão: para no aviso e NÃO diz o que a faixa é. O
  // id abaixo é o da `Fita Caseira` do stub, em hex sem hífen.
  await page.goto('/t/_11111111111141118111111111111111');
  await skipSplash(page);
  await expect(page.getByText(/faixa privada/)).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain('Fita Caseira');
  expect(html).not.toContain('Eu Mesmo');
});

test('a mesma faixa privada abre para quem tem a conta', async ({ page }) => {
  await page.goto('/login');
  await skipSplash(page);
  await page.getByPlaceholder('voce@email.com').fill('thiago@ondas.app');
  await page.getByPlaceholder('••••').fill('senha-forte');
  await page.getByRole('button', { name: /entrar — catálogo completo/ }).click();
  await expect(page.getByRole('button', { name: /^01 Fita Caseira/ })).toBeVisible();

  await page.goto('/t/_11111111111141118111111111111111');
  await expect(page.getByRole('heading', { name: 'Fita Caseira' })).toBeVisible();
  // Sem slug e sem param: a URL de faixa própria não conta o que ela é.
  await expect(page).toHaveURL('/t/_11111111111141118111111111111111');
});

test('compartilhar entrega o link da faixa', async ({ page, context }) => {
  // `navigator.share` de mentira: o que interessa é o que o app manda para
  // ele, não a folha do sistema.
  await page.addInitScript(() => {
    (window as unknown as { __partilha?: unknown[] }).__partilha = [];
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (dados: unknown) => {
        (window as unknown as { __partilha: unknown[] }).__partilha.push(dados);
      },
    });
  });

  await blockAudius(page);
  await page.goto(LINK_DEMO);
  await skipSplash(page);
  await expect(page.getByRole('heading', { name: 'Maré Baixa' })).toBeVisible();

  // Escopado no player: no largo cada linha da lista também tem o botão.
  const botao = page.locator('[class*="keycaps"]').getByRole('button', { name: 'Compartilhar' });
  await botao.click();
  const enviado = await page.evaluate(
    () => (window as unknown as { __partilha: { url: string; title: string }[] }).__partilha[0],
  );
  expect(enviado?.url).toContain(LINK_DEMO);
  expect(enviado?.title).toBe('Maré Baixa');

  // No desktop a tecla `c` faz o mesmo.
  if (page.viewportSize()!.width >= 860) {
    await page.keyboard.press('c');
    const todos = await page.evaluate(
      () => (window as unknown as { __partilha: unknown[] }).__partilha.length,
    );
    expect(todos).toBe(2);
  }

  // Sem `navigator.share`, cai no clipboard e avisa.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
  });
  await botao.click();
  await expect(page.getByText('link copiado')).toBeVisible();
  const copiado = await page.evaluate(() => navigator.clipboard.readText());
  expect(copiado).toContain(LINK_DEMO);
});

/** Entra como visitante em `~/em-alta`, que é onde os atalhos fazem sentido. */
async function entrarVisitante(page: Page) {
  await page.goto('/login');
  await skipSplash(page);
  await page.getByRole('button', { name: /continuar como visitante/ }).click();
  await expect(page.getByRole('button', { name: /Maré Baixa/ })).toBeVisible();
}

/** A linha marcada pelo cursor — `aria-current="true"` só existe nela. */
function cursor(page: Page) {
  return page.locator('[aria-current="true"]');
}

/** Se o elemento está inteiro dentro da janela de rolagem. */
function naTela(alvo: ReturnType<Page['locator']>) {
  return alvo.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  });
}

test('os dígitos abrem as cinco telas, e a janela de atalhos se explica', async ({ page }) => {
  await blockAudius(page);
  await entrarVisitante(page);

  const temas = page.getByRole('dialog', { name: 'ondas +list-themes' });
  await page.keyboard.press('4');
  await expect(temas).toBeVisible();
  // O picker engole o teclado; antes só o Esc o fechava.
  await page.keyboard.press('4');
  await expect(temas).toBeHidden();

  const conta = page.getByRole('dialog', { name: 'ondas whoami' });
  await page.keyboard.press('5');
  await expect(conta).toBeVisible();
  await expect(page).toHaveURL(/account=1/);
  // Alternar, e não abrir de novo: `show()` empilharia um "voltar" vazio.
  await page.keyboard.press('5');
  await expect(conta).toBeHidden();
  await expect(page).not.toHaveURL(/account=1/);

  const ajuda = page.getByRole('dialog', { name: 'ondas --help' });
  await page.keyboard.press('?');
  await expect(ajuda).toBeVisible();
  await expect(ajuda.getByText('tocar ou pausar')).toBeVisible();
  await expect(ajuda.getByText('ir para a faixa pelo número da calha')).toBeVisible();
  // A janela se lista: sem isto, quem a abre não sabe como voltar nela.
  await expect(ajuda.getByText('? ou 6', { exact: true })).toBeVisible();
  // O e2e roda o build de produção, onde o atalho de rede não existe — e a
  // tabela do core é quem tira o grupo `dev` da lista.
  await expect(ajuda.getByText('simular queda de rede')).toBeHidden();

  await page.keyboard.press('6');
  await expect(ajuda).toBeHidden();
  await page.keyboard.press('?');
  await expect(ajuda).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(ajuda).toBeHidden();

  // Trocar de aba leva o overlay embora; antes ele ficava colado com
  // `?shortcuts=1` no endereço.
  await page.keyboard.press('?');
  await expect(ajuda).toBeVisible();
  await page.keyboard.press('3');
  await expect(page).toHaveURL(/library/);
  await expect(page).not.toHaveURL(/shortcuts=1/);
  await expect(ajuda).toBeHidden();

  // `0` são os detalhes do que está tocando — o mesmo que o `f` do handoff.
  await page.keyboard.press('1');
  await page.getByRole('button', { name: /Maré Baixa/ }).click();
  await page.keyboard.press('0');
  await expect(page).toHaveURL(LINK_DEMO);
  await expect(page.getByText('agora-tocando — #ambient')).toBeVisible();
  await page.keyboard.press('0');
  await expect(page).toHaveURL('/');
});

test('j/k andam o cursor, enter toca e `:nº` salta pela calha', async ({ page }) => {
  await blockAudius(page);
  await entrarVisitante(page);

  await page.keyboard.press('j');
  await expect(cursor(page)).toContainText('Maré Baixa');
  await page.keyboard.press('j');
  await expect(cursor(page)).toContainText('Concreto Molhado');
  await page.keyboard.press('k');
  await expect(cursor(page)).toContainText('Maré Baixa');
  // No topo o `k` fica no topo: no vim ele não dá a volta para o fim.
  await page.keyboard.press('k');
  await expect(cursor(page)).toContainText('Maré Baixa');

  await page.keyboard.press('Enter');
  await expect(page.getByText('Maré Baixa — Lia Sombra')).toBeVisible();

  // `:04` → 'Fio de Cobre'. 04 e não 03 porque o selo [pro] é posicional no
  // catálogo demo e a 03 abriria o gate em vez de tocar.
  await page.keyboard.press(':');
  await page.getByLabel('Ir para a faixa pelo número').fill('04');
  await page.keyboard.press('Enter');
  await expect(cursor(page)).toContainText('Fio de Cobre');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Fio de Cobre — Bruma')).toBeVisible();

  // Marcar não serve de nada se a linha estiver fora da janela de rolagem.
  // Aperta a altura de propósito: nos 12 do catálogo demo a lista inteira cabe
  // na tela cheia, e aí o salto não provaria nada.
  const janela = page.viewportSize()!;
  await page.setViewportSize({ width: janela.width, height: 320 });
  const ultima = page.getByRole('button', { name: /Fim de Turno/ });
  expect(await naTela(ultima)).toBe(false);
  await page.keyboard.press(':');
  await page.getByLabel('Ir para a faixa pelo número').fill('12');
  await page.keyboard.press('Enter');
  await expect(cursor(page)).toContainText('Fim de Turno');
  expect(await naTela(cursor(page))).toBe(true);
  await page.setViewportSize(janela);

  // Número que não existe avisa, em vez de não fazer nada em silêncio.
  await page.keyboard.press(':');
  await page.getByLabel('Ir para a faixa pelo número').fill('99');
  await page.keyboard.press('Enter');
  await expect(page.getByText('faixa 99 não existe')).toBeVisible();

  // Com o overlay por cima a lista não está na tela, e o cursor não anda —
  // senão o Enter tocaria algo que ninguém viu. Marca a 01 primeiro: no fim da
  // lista o `j` já pararia por causa do limite, e o teste não provaria nada.
  await page.keyboard.press(':');
  await page.getByLabel('Ir para a faixa pelo número').fill('01');
  await page.keyboard.press('Enter');
  await expect(cursor(page)).toContainText('Maré Baixa');
  await page.keyboard.press('5');
  await expect(page.getByRole('dialog', { name: 'ondas whoami' })).toBeVisible();
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await page.keyboard.press('Escape');
  await expect(cursor(page)).toContainText('Maré Baixa');
});

test('o foco do Tab e a marca da lista são a mesma linha', async ({ page }) => {
  await blockAudius(page);
  await entrarVisitante(page);

  await page.keyboard.press(':');
  await page.getByLabel('Ir para a faixa pelo número').fill('04');
  await page.keyboard.press('Enter');
  await expect(cursor(page)).toContainText('Fio de Cobre');
  // `:04` marca com o foco ainda na linha de comando: a marca não o rouba de
  // um campo que está sendo digitado.
  await expect(page.locator('[aria-current="true"] button').first()).not.toBeFocused();

  // O foco arrasta a marca. Sem isto a tela mostrava duas linhas marcadas — o
  // anel do Tab numa, a barra do cursor noutra — e o Enter obedecia ao anel.
  await page.getByRole('button', { name: /Maré Baixa/ }).focus();
  await expect(cursor(page)).toContainText('Maré Baixa');

  // Enter é A tecla de ativar: num botão focado ele tem de clicar o botão. Se o
  // atalho do cursor desse `preventDefault` aqui, a tecla deixaria de ativar
  // qualquer botão do app — e quem navega por teclado ficaria sem saída.
  await page.keyboard.press('Enter');
  await expect(page.getByText('Maré Baixa — Lia Sombra')).toBeVisible();
  await expect(cursor(page)).toContainText('Maré Baixa');

  // E a volta: com o foco já na lista, `j` o leva junto, em vez de deixar o
  // anel para trás na linha antiga.
  await page.keyboard.press('j');
  await expect(cursor(page)).toContainText('Concreto Molhado');
  await expect(page.locator('[aria-current="true"] button').first()).toBeFocused();

  // Mas só o foco do teclado arrasta a marca. O clique e o toque também focam
  // o botão, e sem essa distinção a barra do cursor apareceria em toda faixa
  // tocada no celular, onde ninguém anda com `j`/`k`.
  await page.getByRole('button', { name: /Último Trem/ }).click();
  await expect(cursor(page)).toContainText('Concreto Molhado');
});

test('`:nº` digita sem acionar atalho, e traz a faixa para uma lista onde ela aparece', async ({
  page,
}) => {
  await blockAudius(page);
  await entrarVisitante(page);

  await page.keyboard.press('3');
  await expect(page).toHaveURL(/library/);

  // Digitar `1` dentro do comando NÃO troca de aba: o campo é um input de
  // verdade, e o guarda `typing` do useShortcuts desliga os atalhos.
  await page.keyboard.press(':');
  await page.getByLabel('Ir para a faixa pelo número').fill('1');
  await expect(page).toHaveURL(/library/);

  // Confirmar leva para `~/em-alta`: o número é posição no catálogo inteiro, e
  // na biblioteca a faixa 01 pode nem estar na lista.
  // Exato: o path limpo é o que zera o chip de gênero, então um `?genre=`
  // pendurado aqui seria a falha que a regex antiga deixava passar.
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/');
  await expect(cursor(page)).toContainText('Maré Baixa');
});

test('o cursor anda pelas linhas da tela, não pelos vizinhos do catálogo', async ({ page }) => {
  await blockAudius(page);
  await entrarVisitante(page);

  // Curte a 01 e a 05 — números de propósito não vizinhos.
  await page
    .getByRole('button', { name: /Maré Baixa/ })
    .locator('xpath=../button[@aria-label="Curtir"]')
    .click();
  await page
    .getByRole('button', { name: /Último Trem/ })
    .locator('xpath=../button[@aria-label="Curtir"]')
    .click();

  await page.keyboard.press('3');
  await expect(page.getByRole('button', { name: /Último Trem/ })).toBeVisible();

  // Na biblioteca a tela tem duas linhas, `01` e `05`. Se o cursor andasse na
  // lista completa, o segundo `j` cairia na 02 — que não está aqui.
  await page.keyboard.press('j');
  await expect(cursor(page)).toContainText('Maré Baixa');
  await page.keyboard.press('j');
  await expect(cursor(page)).toContainText('Último Trem');
});

/* ── O endereço é contextual ao conteúdo ──────────────────────────────────── */

test('recarregar o player volta na mesma faixa', async ({ page }) => {
  await blockAudius(page);
  await entrarVisitante(page);
  await page.getByRole('button', { name: /Maré Baixa/ }).click();
  await page.keyboard.press('0');
  await expect(page).toHaveURL(LINK_DEMO);

  // O que `?player=1` não conseguia: a identidade da faixa está no path, e o
  // `playerStore` não é persistido — então o reload reconstrói a música em vez
  // de abrir um overlay sobre nada.
  await page.reload();
  await skipSplash(page);
  await expect(page).toHaveURL(LINK_DEMO);
  await expect(page.getByRole('heading', { name: 'Maré Baixa' })).toBeVisible();
});

test('fechar o player devolve a tela de origem, com o filtro de lá', async ({ page }) => {
  await blockAudius(page);
  await entrarVisitante(page);

  // O chip de gênero também é endereço, então há uma origem que não é a raiz.
  await page.getByRole('button', { name: 'lofi', exact: true }).click();
  await expect(page).toHaveURL('/?genre=lofi');

  await page.getByRole('button', { name: /Fio de Cobre/ }).click();
  await page.keyboard.press('0');
  await expect(page).toHaveURL(LINK_LOFI);

  // Fechar não é "ir para a home": é voltar para onde se estava, com o recorte
  // intacto.
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL('/?genre=lofi');
  await expect(page.getByRole('button', { name: '[lofi]', exact: true })).toBeVisible();
});

test('a conta abre sobre o player, e cada Esc fecha uma camada', async ({ page }) => {
  await blockAudius(page);
  await entrarVisitante(page);
  await page.getByRole('button', { name: 'lofi', exact: true }).click();
  await page.getByRole('button', { name: /Fio de Cobre/ }).click();
  await page.keyboard.press('0');

  await page.keyboard.press('5');
  await expect(page).toHaveURL(LINK_LOFI + '?account=1');
  await expect(page.getByRole('dialog', { name: 'ondas whoami' })).toBeVisible();

  // Esc tira a conta e deixa o player; o segundo fecha o player. E a tela de
  // origem sobrevive ao overlay: `setSearchParams` navega sem `state`, então
  // sem repassá-lo o fechar cairia na raiz em vez de voltar para `?genre=lofi`.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'ondas whoami' })).toBeHidden();
  await expect(page).toHaveURL(LINK_LOFI);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL('/?genre=lofi');
});

test('o gate [entrar] sai da rota da faixa e vai para o login', async ({ page }) => {
  await blockAudius(page);
  await entrarVisitante(page);
  await page.getByRole('button', { name: /Maré Baixa/ }).click();
  await page.keyboard.press('0');
  await expect(page).toHaveURL(LINK_DEMO);

  // Baixar sem conta abre o gate por cima do player.
  await page.keyboard.press('d');
  const gate = page.getByRole('alertdialog', { name: 'permissão negada' });
  await expect(gate).toBeVisible();

  // Uma navegação só: fechar o player à parte disputaria com esta e devolveria
  // a faixa depois do login empilhado.
  await gate.getByRole('button', { name: /entrar/ }).click();
  await expect(page).toHaveURL(/login/);
});

test('o Esc fecha o gate sem levar a camada de baixo', async ({ page }) => {
  await blockAudius(page);
  await entrarVisitante(page);
  await page.getByRole('button', { name: /Maré Baixa/ }).click();
  await page.keyboard.press('0');
  await page.keyboard.press('d');
  const gate = page.getByRole('alertdialog', { name: 'permissão negada' });
  await expect(gate).toBeVisible();

  // O gate é a camada de cima; fechá-lo não pode fechar o player junto.
  await page.keyboard.press('Escape');
  await expect(gate).toBeHidden();
  await expect(page).toHaveURL(LINK_DEMO);
  await expect(page.getByText('agora-tocando — #ambient')).toBeVisible();
});

test('o segmento da biblioteca é um endereço, e o voltar anda entre eles', async ({ page }) => {
  await blockAudius(page);
  await entrarVisitante(page);

  await page.keyboard.press('3');
  await expect(page).toHaveURL('/library');
  const curtidas = page.getByRole('button', { name: '--curtidas' });
  const offline = page.getByRole('button', { name: '--offline' });
  await expect(curtidas).toHaveAttribute('aria-pressed', 'true');

  await offline.click();
  await expect(page).toHaveURL('/library/offline');
  await expect(offline).toHaveAttribute('aria-pressed', 'true');

  // Quem escolhe o recorte é a URL, não um estado de tela: o voltar troca o
  // chip marcado.
  await page.goBack();
  await expect(page).toHaveURL('/library');
  await expect(curtidas).toHaveAttribute('aria-pressed', 'true');
});

test('a busca mora no endereço, e o voltar não anda letra por letra', async ({ page }) => {
  await blockAudius(page);
  await entrarVisitante(page);

  await page.keyboard.press('2');
  await expect(page).toHaveURL('/search');
  await page.getByLabel('Buscar faixa, artista ou gênero').pressSequentially('bruma');
  await expect(page).toHaveURL('/search?q=bruma');
  await expect(page.getByRole('button', { name: /Fio de Cobre/ })).toBeVisible();

  // Cinco teclas, nenhuma entrada de histórico: digitar escreve com `replace`,
  // senão o voltar desfaria um caractere por vez.
  await page.goBack();
  await expect(page).toHaveURL('/');
});
