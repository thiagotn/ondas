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
    art: '',
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

test('login libera o catálogo e a biblioteca mostra a conta', async ({ page }) => {
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
  await expect(page).toHaveURL(/biblioteca/);
  await expect(page.getByText('catálogo completo + offline')).toBeVisible();
  await expect(page.getByText('0 faixas · 0.0 MB')).toBeVisible();
  await expect(page.getByText('vazio — pressione [l] ou o coração para curtir.')).toBeVisible();
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
  await expect(page.getByText('[meu]')).toBeVisible();
  // A linha do prompt passa a admitir as duas fontes.
  await expect(page.getByText(/\+ acervo \(1\)/)).toBeVisible();

  // O gênero `acervo` vira filtro próprio, de graça. O chip selecionado vem
  // entre colchetes, daí o exact para não casar com a linha da faixa.
  await page.getByRole('button', { name: 'acervo', exact: true }).click();
  await expect(linha('Fita Caseira')).toBeVisible();
  await expect(linha('Maré Baixa')).toBeHidden();
  await page.getByRole('button', { name: 'tudo', exact: true }).click();
  await expect(linha('Maré Baixa')).toBeVisible();

  // Saindo, o acervo some — e o selo [meu] com ele.
  await page.keyboard.press('3');
  await page.getByRole('button', { name: /sair/ }).click();
  await expect(linha('Fita Caseira')).toBeHidden();
  await expect(page.getByText('[meu]')).toBeHidden();
  await expect(page.getByText(/\+ acervo/)).toBeHidden();
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
  await aba(/~\/em-alta/).click();
  await expect(page.getByRole('button', { name: /Noite Fria/ })).toBeVisible();
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

/** Link de faixa do catálogo demo: os ids demo são alfanuméricos, logo parseáveis. */
const LINK_DEMO = '/t/lia-sombra-mare-baixa-demo0';

test('link de faixa abre a música sem passar pelo login', async ({ page }) => {
  await page.goto(LINK_DEMO);
  await skipSplash(page);

  // O ponto do deeplink: quem recebeu o link não vê tela de login.
  await expect(page.getByText('ondas — login')).toBeHidden();
  await expect(page.getByText(/sessão de visitante/)).toBeVisible();

  // O player cheio abre já na faixa certa, e fica na URL.
  await expect(page).toHaveURL(/player=1/);
  await expect(page.getByRole('heading', { name: 'Maré Baixa' })).toBeVisible();
  await expect(page.getByText('Maré Baixa — Lia Sombra')).toBeVisible();
  // Nada de afirmar PLAY/PAUSE: a política de autoplay do Chromium decide
  // isso, e o link promete carregar a faixa, não tocá-la sozinha.

  // Fechando o player, quem chegou pelo link já está no app — sem tela morta.
  await page.getByRole('button', { name: /fechar/ }).click();
  await expect(page.getByText('Concreto Molhado')).toBeVisible();
});

test('link quebrado e link de faixa privada não contam nada', async ({ page }) => {
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
  await expect(page).toHaveURL(/player=1/);
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
