import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

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
 * Um JSON do repositório. Lido com `fs`, e não por `import`: o runner carrega os
 * specs como ESM (o pacote é `type: module`), e ali um `import` de JSON exige
 * atributo de importação — que o transform do Playwright não repassa.
 */
function lerJson(rel: string): unknown {
  return JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
}

/** A versão que o app mostra: a mesma que `pnpm release` escreve no pacote. */
const VERSAO = (lerJson('../package.json') as { version: string }).version;

/** A nota de versão de onde a página `/changelog` é desenhada. */
const NOTAS = lerJson('../../core/src/release/notas.json') as {
  versao: string;
  itens: Record<string, string>[];
}[];

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
 * Faixa de OUTRA conta, que esta pode ouvir.
 *
 * O que a separa da de cima é `owner`: a API só o manda quando a faixa não é de
 * quem pediu, e é a presença dele que põe a linha em `--compartilhadas` em vez
 * de `--acervo`.
 *
 * Fica FORA de `ACERVO` e entra por `semearCompartilhada`, pelo mesmo motivo da
 * curtida semeada: metade da suíte conta as faixas da lista (`+ acervo (1)`,
 * `só o acervo`, o envio) e pô-la no fixture global mudaria os números de uns
 * seis testes que não falam de compartilhamento nenhum.
 */
const COMPARTILHADA = {
  id: 'acervo:33333333-3333-4333-8333-333333333333',
  title: 'Vinda de Longe',
  artist: 'Outra Pessoa',
  genre: 'acervo',
  dur: 212,
  art: '',
  stream: '/api/acervo/33333333-3333-4333-8333-333333333333/audio',
  premium: false,
  owner: 'mayumi',
};

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
/**
 * As curtidas do servidor de mentira, por página — para um teste poder semear
 * uma curtida antes do login e provar que o coração veio de lá, e não do
 * espelho local.
 */
const curtidasSemeadas = new WeakMap<Page, Set<string>>();

/** As playlists da API falsa, por página — ver `semearPlaylist`. */
const playlistsSemeadas = new WeakMap<
  Page,
  { id: string; nome: string; itens: string[] }[]
>();

/**
 * Põe uma playlist no servidor de mentira ANTES do login.
 *
 * É o que deixa um teste provar que a fileira de playlists veio do servidor, e
 * não de um espelho que este navegador tinha guardado.
 */
function semearPlaylist(page: Page, nome: string, itens: string[]) {
  playlistsSemeadas.get(page)?.push({ id: `semeada-${nome}`, nome, itens });
}

function semearCurtida(page: Page, id: string) {
  curtidasSemeadas.get(page)?.add(id);
}

/** O acervo mutável da API falsa, por página — ver `semearCompartilhada`. */
const acervoSemeado = new WeakMap<Page, Record<string, unknown>[]>();

/** Põe no acervo desta página uma faixa que é de outra conta. */
function semearCompartilhada(page: Page) {
  acervoSemeado.get(page)?.push({ ...COMPARTILHADA });
}

interface MarcadorFalso {
  trackId: string;
  pos: number;
  dur: number;
  em: number;
}

interface ItemFalso {
  trackId: string;
  titulo: string;
  artista: string;
  dur: number;
  em: number;
}

/**
 * O que a conta ouviu, no servidor de mentira — por página.
 *
 * `puts` guarda toda escrita do marcador que CHEGOU, aceita ou não: é o que
 * deixa um teste afirmar "este aparelho não escreveu nada", que é metade da
 * regra de conflito entre aparelhos.
 */
const ouvidoSemeado = new WeakMap<
  Page,
  { marcador: MarcadorFalso | null; puts: MarcadorFalso[]; historico: ItemFalso[] }
>();

/**
 * Põe um marcador na conta ANTES do login, como se outro aparelho tivesse
 * ouvido. Não há jeito de ele estar no IndexedDB desta página, então um player
 * que aparece armado só pode ter vindo do `/api/playback`.
 */
function semearMarcador(page: Page, trackId: string, pos: number, dur: number) {
  // Um minuto atrás: mais velho que qualquer coisa que o teste ouça depois.
  ouvidoSemeado.get(page)!.marcador = { trackId, pos, dur, em: Date.now() - 60_000 };
}

function semearHistorico(page: Page, ...itens: Omit<ItemFalso, 'em'>[]) {
  const agora = Date.now();
  // Na ordem dada, do mais recente para trás.
  ouvidoSemeado.get(page)!.historico.push(...itens.map((it, i) => ({ ...it, em: agora - i * 60_000 })));
}

/**
 * A aparência da conta, no servidor de mentira — por página.
 *
 * `prefs` é o que a conta tem; `undefined` é uma API de ANTES das preferências,
 * que nem manda a chave nem aceita o campo (ver `apiSemPrefs`).
 *
 * `patches` guarda toda escrita de aparência que CHEGOU. Como os `puts` do
 * marcador, é o que deixa um teste afirmar "este aparelho não escreveu nada" —
 * que aqui é a regra inteira: aplicar o que veio da conta não pode virar um
 * PATCH de volta.
 */
const prefsSemeadas = new WeakMap<
  Page,
  {
    prefs: Record<string, unknown> | undefined;
    patches: Record<string, unknown>[];
    recusados: number;
    /** `undefined` = servidor de antes do campo: nem manda a chave. */
    podeEnviar: boolean | undefined;
    /** O nome que a conta escolheu (`PATCH /auth/conta`); sem ele, o de sempre. */
    nome: string | undefined;
    /** A senha da conta de mentira, para as ações que a pedem de novo. */
    senha: string;
    /** Os pedidos de conta que chegaram ao `/signup`. */
    pedidos: Record<string, unknown>[];
    apagada: boolean;
  }
>();

/** Põe preferências na conta ANTES do login, como se outro aparelho as tivesse escolhido. */
function semearPrefs(page: Page, prefs: Record<string, unknown>) {
  Object.assign(prefsSemeadas.get(page)!.prefs!, prefs);
}

/** Faz a API se comportar como a de antes das preferências. */
function apiSemPrefs(page: Page) {
  prefsSemeadas.get(page)!.prefs = undefined;
}

const contaFalsa = (page: Page) => prefsSemeadas.get(page)!;

async function stubApi(page: Page) {
  let logado = false;
  const conta: NonNullable<ReturnType<typeof prefsSemeadas.get>> = {
    prefs: {},
    patches: [],
    recusados: 0,
    podeEnviar: undefined,
    nome: undefined,
    senha: 'senha-forte',
    pedidos: [],
    apagada: false,
  };
  prefsSemeadas.set(page, conta);
  // `prefs` sai em toda resposta de auth quando o servidor as guarda — é a
  // presença da chave que a PWA lê como "pode mandar". `podeEnviar` vai junto
  // aqui por ser a mesma regra: só sai quando o teste o semeou.
  const aparencia = () => ({
    ...(conta.prefs ? { prefs: conta.prefs } : {}),
    ...(conta.podeEnviar === undefined ? {} : { podeEnviar: conta.podeEnviar }),
  });
  const nomeDe = (padrao: string) => conta.nome ?? padrao;
  // `true` de propósito, e não "realista".
  //
  // O usuário de teste TEM faixa no acervo, então um servidor de verdade
  // congelaria a preferência em `false` na migração — e aí o catálogo demo
  // desapareceria de todo teste logado, levando uns oito consigo (o do envio,
  // o do chip `lofi`, o do `+ acervo (1)`). Mantendo ligado, a suíte continua
  // falando do que ela sempre falou, e quem exercita o desligamento é o teste
  // que o liga explicitamente.
  let publico = true;
  // O acervo cresce durante o teste de envio: é assim que se prova que a
  // faixa nova aparece na lista depois da ingestão.
  const acervo: Record<string, unknown>[] = ACERVO.map((t) => ({ ...t }));
  acervoSemeado.set(page, acervo);
  let enviosRecebidos = 0;
  // As curtidas da conta, no servidor de mentira. Começa vazio; quem quiser
  // uma curtida pré-existente a semeia com `semearCurtida`.
  const curtidas = new Set<string>();
  curtidasSemeadas.set(page, curtidas);

  await page.route('**/api/auth/login', async (route) => {
    const { email, password } = JSON.parse(route.request().postData() ?? '{}');
    if (!/.+@.+\..+/.test(email ?? '')) {
      return route.fulfill({ status: 400, json: { error: 'e-mail inválido' } });
    }
    if ((password ?? '').length < 8) {
      return route.fulfill({ status: 400, json: { error: 'senha precisa de 8+ caracteres' } });
    }
    // Os dois estados de um pedido de conta, pelo e-mail: é o servidor quem
    // sabe em que pé o pedido está, e a tela só repete o que ele disse.
    if (email.startsWith('pendente@')) {
      return route.fulfill({
        status: 403,
        json: { error: 'conta em análise', code: 'conta_em_analise' },
      });
    }
    if (email.startsWith('negada@')) {
      return route.fulfill({
        status: 403,
        json: { error: 'cadastro negado', code: 'cadastro_negado' },
      });
    }
    if (conta.apagada) {
      return route.fulfill({
        status: 401,
        json: { error: 'credenciais inválidas', code: 'credenciais_invalidas' },
      });
    }
    logado = true;
    return route.fulfill({
      status: 200,
      json: { name: nomeDe(email.split('@')[0]), email, publico, ...aparencia() },
    });
  });

  // O pedido de conta. 202 sem cookie: a conta existe, mas não entra.
  await page.route('**/api/auth/signup', async (route) => {
    const corpo = JSON.parse(route.request().postData() ?? '{}');
    if (!/.+@.+\..+/.test(corpo.email ?? '')) {
      return route.fulfill({
        status: 400,
        json: { error: 'e-mail inválido', code: 'email_invalido' },
      });
    }
    if ((corpo.password ?? '').length < 8) {
      return route.fulfill({
        status: 400,
        json: {
          error: 'senha precisa de 8+ caracteres',
          code: 'senha_curta',
          params: { minimo: 8 },
        },
      });
    }
    conta.pedidos.push(corpo);
    return route.fulfill({ status: 202, json: { status: 'pendente' } });
  });

  // A conta mexendo em si mesma. Rotas OBRIGATÓRIAS pelo motivo da de `prefs`,
  // logo abaixo: sem elas o PATCH/POST escaparia para o `vite preview`.
  const senhaErrada = (route: Route) =>
    route.fulfill({
      status: 403,
      json: { error: 'senha atual incorreta', code: 'senha_atual_incorreta' },
    });
  const semSessao = (route: Route) =>
    route.fulfill({ status: 401, json: { error: 'sessão expirada' } });

  await page.route('**/api/auth/conta', async (route) => {
    if (!logado) return semSessao(route);
    conta.nome = String(JSON.parse(route.request().postData() ?? '{}').name ?? '').trim();
    return route.fulfill({
      status: 200,
      json: { name: conta.nome, email: 'thiago@ondas.app', publico, ...aparencia() },
    });
  });

  await page.route('**/api/auth/senha', async (route) => {
    if (!logado) return semSessao(route);
    const { atual, nova } = JSON.parse(route.request().postData() ?? '{}');
    if (atual !== conta.senha) return senhaErrada(route);
    conta.senha = nova;
    return route.fulfill({ status: 200, json: { status: 'ok' } });
  });

  await page.route('**/api/auth/conta/apagar', async (route) => {
    if (!logado) return semSessao(route);
    const { senha } = JSON.parse(route.request().postData() ?? '{}');
    if (senha !== conta.senha) return senhaErrada(route);
    logado = false;
    conta.apagada = true;
    return route.fulfill({ status: 200, json: { status: 'apagada' } });
  });

  await page.route('**/api/auth/logout', async (route) => {
    logado = false;
    return route.fulfill({ status: 200, json: { status: 'ok' } });
  });

  await page.route('**/api/auth/me', async (route) =>
    logado
      ? route.fulfill({
          status: 200,
          json: { name: nomeDe('thiago'), email: 'thiago@ondas.app', publico, ...aparencia() },
        })
      : route.fulfill({ status: 401, json: { error: 'sessão expirada' } }),
  );

  // A preferência guarda estado no closure, como `logado` e `acervo`: é o que
  // faz o `/me` do reload concordar com o que foi clicado.
  //
  // A rota é OBRIGATÓRIA, não um capricho: sem ela o PATCH escapa para o
  // `vite preview`, cujo fallback de SPA só serve GET/HEAD, e o teste falharia
  // com 405 por um motivo que não tem nada a ver com a feature.
  await page.route('**/api/auth/prefs', async (route) => {
    if (!logado) return route.fulfill({ status: 401, json: { error: 'sessão expirada' } });
    const corpo = JSON.parse(route.request().postData() ?? '{}');
    const invalido = () =>
      route.fulfill({
        status: 400,
        json: { error: 'requisição inválida', code: 'requisicao_invalida' },
      });
    const temPublico = typeof corpo.publico === 'boolean';
    const temPrefs = corpo.prefs && typeof corpo.prefs === 'object';
    // A API de antes das preferências recusa o campo que não conhece
    // (`DisallowUnknownFields` no `lerJSON`), e é isso que o stub imita.
    if (temPrefs && !conta.prefs) {
      conta.recusados += 1;
      return invalido();
    }
    if (!temPublico && !(temPrefs && Object.keys(corpo.prefs).length)) return invalido();
    if (temPublico) publico = corpo.publico;
    if (temPrefs) {
      conta.patches.push(corpo.prefs);
      // Parcial, como o `COALESCE` do servidor: o que não vem fica.
      Object.assign(conta.prefs!, corpo.prefs);
    }
    return route.fulfill({
      status: 200,
      json: { name: nomeDe('thiago'), email: 'thiago@ondas.app', publico, ...aparencia() },
    });
  });

  // A rota é OBRIGATÓRIA pelo mesmo motivo da de `prefs`: um PATCH sem rota
  // escapa para o `vite preview`, cujo fallback de SPA só serve GET/HEAD, e o
  // teste falharia com 405 por um motivo que não tem nada a ver com a feature.
  //
  // O `Set` guarda estado no closure, como `logado` e `acervo`: é o que faz a
  // curtida sobreviver a um reload, e é o que deixa um teste semear uma
  // curtida ANTES do login para provar que ela veio do servidor.
  await page.route('**/api/likes', async (route) => {
    if (!logado) return route.fulfill({ status: 401, json: { error: 'sessão expirada' } });
    if (route.request().method() === 'PATCH') {
      const corpo = JSON.parse(route.request().postData() ?? '{}');
      for (const id of corpo.remove ?? []) curtidas.delete(id);
      for (const id of corpo.add ?? []) curtidas.add(id);
    }
    return route.fulfill({ status: 200, json: { ids: [...curtidas] } });
  });

  // As playlists da conta, no servidor de mentira.
  //
  // Guarda estado no closure como as curtidas, e pelo mesmo motivo: é o que faz
  // a playlist sobreviver a um reload, e é o que deixa um teste provar que ela
  // VEIO do servidor e não do espelho deste navegador.
  //
  // O comportamento copia o da API de verdade nos três pontos que a tela
  // depende: toda resposta é a coleção INTEIRA, `add` anexa no fim sem duplicar
  // (é a PK dos itens lá), e `ordem` reescreve a ordem ignorando id que não é
  // item.
  const listas: { id: string; nome: string; itens: string[] }[] = [];
  playlistsSemeadas.set(page, listas);
  let proximoID = 1;

  await page.route(/\/api\/playlists(\/[^?]*)?$/, async (route) => {
    if (!logado) return route.fulfill({ status: 401, json: { error: 'sessão expirada' } });
    const metodo = route.request().method();
    const url = new URL(route.request().url());
    const partes = url.pathname.split('/').filter(Boolean);
    // /api/playlists | /api/playlists/<id> | /api/playlists/<id>/itens
    const id = partes[2];
    const corpo = JSON.parse(route.request().postData() ?? '{}');
    const responder = (status = 200) =>
      route.fulfill({ status, json: { playlists: listas } });

    if (metodo === 'GET') return responder();

    if (metodo === 'POST' && !id) {
      const nome = String(corpo.nome ?? '').trim();
      if (listas.some((p) => p.nome.toLowerCase() === nome.toLowerCase())) {
        return route.fulfill({
          status: 409,
          json: { error: 'já existe uma playlist com esse nome' },
        });
      }
      listas.push({ id: `pl-${proximoID++}`, nome, itens: [] });
      return responder(201);
    }

    const lista = listas.find((p) => p.id === id);
    if (!lista) return route.fulfill({ status: 404, json: { error: 'playlist não encontrada' } });

    if (metodo === 'DELETE') {
      listas.splice(listas.indexOf(lista), 1);
      return responder();
    }
    if (metodo === 'PATCH' && partes[3] === 'itens') {
      for (const it of corpo.remove ?? []) {
        const i = lista.itens.indexOf(it);
        if (i >= 0) lista.itens.splice(i, 1);
      }
      for (const it of corpo.add ?? []) {
        if (!lista.itens.includes(it)) lista.itens.push(it);
      }
      if (corpo.ordem) {
        const pedida = (corpo.ordem as string[]).filter((it) => lista.itens.includes(it));
        lista.itens = pedida;
      }
      return responder();
    }
    if (metodo === 'PATCH') {
      lista.nome = String(corpo.nome ?? '').trim();
      return responder();
    }
    return route.fulfill({ status: 405, json: { error: 'método não suportado' } });
  });

  // O marcador e o histórico da conta.
  //
  // As rotas são OBRIGATÓRIAS pelo mesmo motivo das de cima, e aqui com mais
  // peso: a PWA escreve o marcador sozinha, a cada faixa que toca. Sem elas
  // TODO teste logado que toca música mandaria um PUT ao `vite preview` e
  // levaria 405.
  //
  // O PUT copia a regra do servidor que a tela depende: escrita mais velha que
  // a vigente é ignorada, e a resposta é o marcador que FICOU.
  const ouvido: { marcador: MarcadorFalso | null; puts: MarcadorFalso[]; historico: ItemFalso[] } = {
    marcador: null,
    puts: [],
    historico: [],
  };
  ouvidoSemeado.set(page, ouvido);

  await page.route('**/api/playback', async (route) => {
    if (!logado) return route.fulfill({ status: 401, json: { error: 'sessão expirada' } });
    if (route.request().method() === 'PUT') {
      const corpo = JSON.parse(route.request().postData() ?? '{}') as MarcadorFalso;
      ouvido.puts.push(corpo);
      if (!ouvido.marcador || ouvido.marcador.em <= corpo.em) ouvido.marcador = corpo;
    }
    return route.fulfill({ status: 200, json: { marcador: ouvido.marcador } });
  });

  await page.route('**/api/history', async (route) => {
    if (!logado) return route.fulfill({ status: 401, json: { error: 'sessão expirada' } });
    const metodo = route.request().method();
    if (metodo === 'DELETE') ouvido.historico = [];
    if (metodo === 'POST') {
      const { itens } = JSON.parse(route.request().postData() ?? '{}') as { itens: ItemFalso[] };
      for (const it of itens ?? []) {
        ouvido.historico = ouvido.historico.filter((x) => x.trackId !== it.trackId);
        ouvido.historico.push(it);
      }
    }
    ouvido.historico.sort((a, b) => b.em - a.em);
    return route.fulfill({ status: 200, json: { itens: ouvido.historico } });
  });

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
  await expect(page.getByText('a grande onda', { exact: true })).toBeVisible();

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

test('o login fica no meio da janela larga e no topo da estreita', async ({ page }) => {
  await page.goto('/login');
  await skipSplash(page);

  const janela = page.viewportSize()!;
  const caixa = (await page.getByRole('button', { name: /continuar como visitante/ }).boundingBox())!;
  const esquerda = caixa.x;
  const direita = janela.width - (caixa.x + caixa.width);

  if (janela.width >= 860) {
    // As duas sobras iguais, e não só "longe da borda": um `margin-left` fixo
    // também afastaria o bloco e continuaria torto.
    expect(Math.abs(esquerda - direita)).toBeLessThanOrEqual(1);
    expect(esquerda).toBeGreaterThan(100);

    // E na vertical: do lockup ao último botão, o bloco tem a mesma sobra em
    // cima e embaixo.
    const topo = (await page.getByText('ondas', { exact: true }).boundingBox())!.y;
    const fim = caixa.y + caixa.height;
    expect(Math.abs((topo + fim) / 2 - janela.height / 2)).toBeLessThan(40);
  } else {
    // No celular nada muda: largura toda, logo abaixo da barra.
    expect(esquerda).toBeLessThanOrEqual(24);
    expect(direita).toBeLessThanOrEqual(24);
    const topo = (await page.getByText('ondas', { exact: true }).boundingBox())!.y;
    expect(topo).toBeLessThan(140);
  }
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
  // Com conta, `/library` sem segmento abre no acervo: é o que é da pessoa, e
  // o recorte que o envio alimenta. A faixa própria do stub já está na lista.
  await expect(page.getByRole('button', { name: '--acervo' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: /Fita Caseira/ })).toBeVisible();
  // A biblioteca é só biblioteca: plano e ocupação não moram mais nela.
  await expect(page.getByText('catálogo completo + offline')).toBeHidden();
  await expect(page.getByText('0 faixas · 0,0 MB')).toBeHidden();

  // Eles moram atrás do próprio nome — aqui o do prompt, no alto.
  await abrirConta(page);
  const conta = page.getByRole('dialog', { name: 'ondas whoami' });
  await expect(conta.getByText('catálogo completo + offline')).toBeVisible();
  await expect(conta.getByText('0 faixas · 0,0 MB')).toBeVisible();

  // Esc fecha uma camada e devolve o endereço.
  await page.keyboard.press('Escape');
  await expect(conta).toBeHidden();
  await expect(page).not.toHaveURL(/account=1/);
});

test('o acervo aparece só logado, sem selo na linha, e some ao sair', async ({ page }) => {
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
  // A linha não leva selo de dono em largura nenhuma: faixa do acervo sem
  // `[de <nome>]` é minha.
  await expect(page.getByText('[meu]')).toHaveCount(0);
  // Nem a etiqueta `#acervo`, em largura nenhuma: toda faixa do acervo tem esse
  // "gênero", então ela só repetia, linha após linha, de onde a faixa veio. As
  // do catálogo público continuam com o gênero delas.
  await expect(page.getByText('#acervo')).toHaveCount(0);
  await expect(page.getByText('#ambient').first()).toBeVisible();
  // A linha do prompt passa a admitir as duas fontes.
  await expect(page.getByText(/\+ acervo \(1\)/)).toBeVisible();

  // O gênero `acervo` vira filtro próprio, de graça. O chip selecionado vem
  // entre colchetes, daí o exact para não casar com a linha da faixa.
  await page.getByRole('button', { name: 'acervo', exact: true }).click();
  await expect(linha('Fita Caseira')).toBeVisible();
  await expect(linha('Maré Baixa')).toBeHidden();
  await page.getByRole('button', { name: 'tudo', exact: true }).click();
  await expect(linha('Maré Baixa')).toBeVisible();

  // Saindo, o acervo some. `[sair]` agora vive em
  // `ondas whoami`, não na biblioteca.
  await abrirConta(page);
  await page.getByRole('button', { name: '[sair]' }).click();
  await expect(page).toHaveURL(/login/);

  // De volta ao app como visitante: é AQUI que a ausência do acervo vale,
  // não na tela de login, onde lista nenhuma existe.
  await page.getByRole('button', { name: /continuar como visitante/ }).click();
  await expect(linha('Maré Baixa')).toBeVisible();
  await expect(linha('Fita Caseira')).toBeHidden();
  await expect(page.getByText(/\+ acervo/)).toBeHidden();
});

test('desligar o catálogo público deixa só o acervo — e o player não vira fantasma', async ({
  page,
}) => {
  const linha = (titulo: string) => page.getByRole('button', { name: new RegExp(titulo) });

  await page.goto('/login');
  await skipSplash(page);
  await page.getByPlaceholder('voce@email.com').fill('thiago@ondas.app');
  await page.getByPlaceholder('••••').fill('senha-forte');
  await page.getByRole('button', { name: /entrar — catálogo completo/ }).click();
  await expect(page.getByRole('button', { name: /^01 Fita Caseira/ })).toBeVisible();

  // Toca uma faixa PÚBLICA, e é esse o ponto do teste: ela está prestes a sair
  // da lista. Se a troca de escopo da consulta deixar um commit com a lista
  // vazia, a reancoragem crava `cur: -1` e a barra de baixo desaparece com o
  // áudio tocando — o pior estado possível de um player, e o que
  // `controller.togglePublico` semeia a chave nova para evitar.
  await linha('Maré Baixa').click();
  const barra = page.getByText('Maré Baixa');
  await expect(barra.first()).toBeVisible();

  await abrirConta(page);
  const conta = page.getByRole('dialog', { name: 'ondas whoami' });
  const chave = conta.getByRole('button', { name: /catálogo/ });
  await expect(chave).toHaveAttribute('aria-pressed', 'true');
  await chave.click();
  await expect(chave).toHaveAttribute('aria-pressed', 'false');

  // A linha `plano` acompanha: "catálogo completo" encostado em "desligado"
  // seria contradição na mesma tela.
  await expect(conta.getByText('acervo + offline')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(conta).toBeHidden();

  // (a) A FAIXA QUE TOCA CONTINUA NA TELA, apesar de ter saído do catálogo.
  await expect(barra.first()).toBeVisible();

  // (b) A lista é o acervo e nada mais.
  await expect(linha('Fita Caseira')).toBeVisible();
  await expect(page.getByRole('button', { name: /^01 Fita Caseira/ })).toBeVisible();

  // (c) A fonte diz só o acervo, sem repetir a contagem que já está à esquerda.
  await expect(page.getByText('fonte: só o acervo')).toBeVisible();
  await expect(page.getByText(/só o acervo \(/)).toBeHidden();

  // (d) Sobrevive ao reload: a preferência é da conta, e vem pelo `/me`.
  await page.goto('/');
  await skipSplash(page);
  await expect(linha('Fita Caseira')).toBeVisible();
  await expect(page.getByText('fonte: só o acervo')).toBeVisible();

  // (e) Religar traz o catálogo público de volta.
  await abrirConta(page);
  await conta.getByRole('button', { name: /catálogo/ }).click();
  await page.keyboard.press('Escape');
  await expect(linha('Maré Baixa')).toBeVisible();
  await expect(page.getByText(/\+ acervo \(1\)/)).toBeVisible();
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
  await expect(conta.getByText('0 faixas · 0,0 MB')).toBeVisible();
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
  await expect(conta.getByText(/^1 faixa · \d+,\d MB$/)).toBeVisible();
  await conta.getByRole('button', { name: '[limpar downloads]' }).click();
  // O primeiro toque só pergunta: apagar não dá para desfazer.
  await expect(conta.getByText('apagar 1?')).toBeVisible();
  await expect(conta.getByText(/^1 faixa ·/)).toBeVisible();
  await conta.getByRole('button', { name: '[sim]' }).click();
  await expect(conta.getByText('0 faixas · 0,0 MB')).toBeVisible();
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
  // faixa, não por curtida nem download. Com conta é onde `/library` abre, daí
  // a enviada já estar na lista — e `--curtidas` continuar vazia.
  await expect(page.getByRole('button', { name: /Noite Fria/ })).toBeVisible();
  await page.getByRole('button', { name: '--curtidas' }).click();
  await expect(page).toHaveURL('/library/liked');
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

/**
 * Entra com a conta de teste e espera a lista do logado chegar.
 *
 * `linha` é a faixa do acervo como a lista a desenha — `01` na calha. Quem
 * semeia um marcador NESSA faixa passa a marca de pausa no lugar do número,
 * porque a retomada a deixa como a faixa corrente.
 */
async function logar(page: Page, linha = /^01 Fita Caseira/) {
  await page.goto('/login');
  await skipSplash(page);
  await preencherLogin(page, linha);
}

/**
 * O formulário de login, SEM navegar até ele.
 *
 * Separado de `logar` por causa de quem testa o que sobra de uma conta para a
 * outra: `page.goto` recarrega a página, e um boot novo já limpa por conta
 * própria o que era da sessão que caiu. Sair e entrar de novo na MESMA página
 * é o caminho em que só a limpeza do `logout()` protege.
 */
async function preencherLogin(page: Page, linha = /^01 Fita Caseira/) {
  await page.getByPlaceholder('voce@email.com').fill('thiago@ondas.app');
  await page.getByPlaceholder('••••').fill('senha-forte');
  await page.getByRole('button', { name: /entrar — catálogo completo/ }).click();
  await expect(page.getByRole('button', { name: linha })).toBeVisible({
    timeout: 30000,
  });
}

async function logarEtocarAcervo(page: Page) {
  await logar(page);
  await page.getByRole('button', { name: /^01 Fita Caseira/ }).click();
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
  // E nada ficou marcado como baixado: o ✓ do botão é a marca, e ele troca
  // o rótulo para "remover do aparelho".
  await expect(page.getByRole('button', { name: 'remover do aparelho' })).toHaveCount(0);
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
    page.getByRole('dialog', { name: 'ondas whoami' }).getByText('3,0 GB livres de 4,2 GB'),
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

/**
 * A abertura roda no boot, e só ali: o `[rever abertura]` do `ondas --about`
 * saiu, e com ele a única porta para revê-la. O que resta é o que esta tela
 * sempre prometeu — aparecer ao chegar e sair de cena num toque.
 */
test('a abertura toca no boot, e um toque a pula', async ({ page }) => {
  await page.goto('/login');

  const splash = page.getByRole('button', { name: 'pular abertura' });
  await expect(splash).toBeVisible();
  await expect(page.getByText('a grande onda · streaming independente')).toBeVisible();

  // Um toque pula — não é preciso esperar os 2,2s.
  await splash.click();
  await expect(splash).toBeHidden();

  // E entrar no app não a traz de volta: ela não roda duas vezes na sessão.
  await page.getByRole('button', { name: /continuar como visitante/ }).click();
  await expect(splash).toBeHidden();
  await page.getByRole('button', { name: 'ondas — sobre' }).click();
  const sobre = page.getByRole('dialog', { name: 'ondas --about' });
  await expect(sobre).toBeVisible();
  await expect(sobre.getByRole('button', { name: '[rever abertura]' })).toHaveCount(0);
});

test('o logo da barra abre `ondas --about`, e a tecla 7 alterna a janela', async ({ page }) => {
  await page.goto('/login');
  await skipSplash(page);
  await page.getByRole('button', { name: /continuar como visitante/ }).click();

  const sobre = page.getByRole('dialog', { name: 'ondas --about' });

  await page.getByRole('button', { name: 'ondas — sobre' }).click();
  await expect(page).toHaveURL(/about=1/);
  await expect(sobre).toBeVisible();
  await expect(sobre.getByText(/side projects de @thiagotn/)).toBeVisible();

  // O `@thiagotn` da frase É o link do github — a linha de autor do painel, que
  // repetia o nome e carregava um `[github]` solto, saiu.
  const autor = sobre.getByRole('link', { name: '@thiagotn' });
  await expect(autor).toHaveAttribute('href', 'https://github.com/thiagotn');
  await expect(sobre.getByText('autor', { exact: true })).toHaveCount(0);

  // Fechar pelo Esc, abrir e fechar pela tecla — ela alterna, como a 5.
  await page.keyboard.press('Escape');
  await expect(sobre).toBeHidden();
  await page.keyboard.press('7');
  await expect(sobre).toBeVisible();
  await page.keyboard.press('7');
  await expect(sobre).toBeHidden();

  // E o voltar do aparelho fecha, que é o motivo de o estado morar na URL.
  await page.keyboard.press('7');
  await expect(sobre).toBeVisible();
  await page.goBack();
  await expect(sobre).toBeHidden();
});

/**
 * A versão deixa de ser um número solto: a linha dela no sobre leva às notas.
 *
 * A versão esperada sai do `package.json` — o mesmo lugar de onde o Vite monta
 * o `__APP_VERSION__` que a tela mostra, e onde `pnpm release` a escreve a cada
 * entrega. Fixar `1.1.0` aqui faria o teste quebrar na próxima entrega, que é
 * exatamente quando ele precisa continuar valendo.
 */
test('a linha da versão no sobre leva às notas daquela versão', async ({ page }) => {
  await page.goto('/login');
  await skipSplash(page);
  await page.getByRole('button', { name: /continuar como visitante/ }).click();

  await page.keyboard.press('7');
  const sobre = page.getByRole('dialog', { name: 'ondas --about' });
  await expect(sobre.getByText(VERSAO, { exact: true })).toBeVisible();

  // O link fica na MESMA linha do número, e tem de ficar na mesma altura dele.
  // Os 32px de alvo de toque do `.link` eram desenhados para `<button>`, onde o
  // navegador centra o conteúdo sozinho; neste `<a>` a linha encostava no topo
  // da caixa e subia ~7px em relação ao `1.1.1` ao lado.
  //
  // A medida é do TEXTO, por um `Range`, e não da caixa: a caixa do link já era
  // centrada na linha — era o que estava dentro dela que não era.
  const notas = sobre.getByRole('link', { name: '[notas da versão]' });
  const meioDoLink = await notas.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const { y, height } = r.getBoundingClientRect();
    return y + height / 2;
  });
  const numero = (await sobre.getByText(VERSAO, { exact: true }).boundingBox())!;
  expect(Math.abs(meioDoLink - (numero.y + numero.height / 2))).toBeLessThan(2);

  await notas.click();
  await expect(page).toHaveURL(/\/changelog$/);
  // A janela foi embora com a navegação: o `?about=1` saiu do endereço.
  await expect(sobre).toBeHidden();

  await expect(page.getByText('ondas --changelog')).toBeVisible();
  await expect(page.getByText(`v${VERSAO}`, { exact: true })).toBeVisible();
  // A versão que está rodando é a marcada.
  await expect(page.getByText('[em uso]')).toBeVisible();
  // E o que a tela escreve é o que está na nota, item por item: a página lê o
  // MESMO arquivo de onde saem o `CHANGELOG.md` e a versão dos pacotes.
  await expect(page.getByText(NOTAS[0]!.itens[0]!['pt-BR']!)).toBeVisible();

  // O endereço é servido pelo fallback de SPA, e não como arquivo: recarregar
  // devolve 200 com o HTML do app, e não um 404. Quem estava como visitante cai
  // no login porque o modo visitante dura só a sessão (ver `app/guest.ts`) — o
  // que importa aqui é que o servidor entregou o app, não um erro.
  const recarga = await page.reload();
  expect(recarga?.status()).toBe(200);
  await expect(page.getByRole('button', { name: /continuar como visitante/ })).toBeVisible();
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
  await expect(page.getByText('~/em-alta').first()).toBeVisible();

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
  // Com conta, e não como visitante: curtir virou coisa da conta.
  await logar(page);

  // Curte duas faixas de propósito não vizinhas.
  await page
    .getByRole('button', { name: /Maré Baixa/ })
    .locator('xpath=../button[@aria-label="Curtir"]')
    .click();
  await page
    .getByRole('button', { name: /Último Trem/ })
    .locator('xpath=../button[@aria-label="Curtir"]')
    .click();

  await page.keyboard.press('3');
  // Com conta `/library` abre no acervo; o recorte deste teste é o das curtidas.
  await page.getByRole('button', { name: '--curtidas' }).click();
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
  //
  // É visitante de propósito: com conta existe o marcador, que traz de volta
  // também o SEGUNDO onde a faixa parou (ver "O marcador é da conta", abaixo).
  // Aqui o que se prova é a parte que não depende de conta nenhuma.
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

/* ── A curtida é da conta ─────────────────────────────────────────────────── */

const coracao = (page: Page, faixa: RegExp) =>
  page.getByRole('button', { name: faixa }).locator('xpath=../button[@aria-pressed]').first();

test('a curtida vem do servidor, não do espelho deste navegador', async ({ page }) => {
  await blockAudius(page);
  // Semeada ANTES do login: não existe jeito de ela estar no IndexedDB desta
  // página, então um coração cheio só pode ter vindo do `/api/likes`. É isso
  // que separa este teste de um que passaria mesmo se nada subisse.
  semearCurtida(page, 'demo0');
  await logar(page);

  await expect(
    page.getByRole('button', { name: /Maré Baixa/ }).locator('xpath=../button[@aria-pressed]'),
  ).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('3');
  await page.getByRole('button', { name: '--curtidas' }).click();
  await expect(page.getByRole('button', { name: /Maré Baixa/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Último Trem/ })).toBeHidden();
});

test('sair leva as curtidas, e entrar de novo as traz de volta', async ({ page }) => {
  await blockAudius(page);
  await logar(page);

  await coracao(page, /Maré Baixa/).click();
  await expect(
    page.getByRole('button', { name: /Maré Baixa/ }).locator('xpath=../button[@aria-pressed]'),
  ).toHaveAttribute('aria-pressed', 'true');

  // Sair tem de limpar: curtida que ficasse no aparelho seria adotada pela
  // PRÓXIMA conta que entrasse neste navegador.
  await page.keyboard.press('5');
  await page.getByRole('button', { name: /sair/ }).click();
  await expect(page).toHaveURL(/login/);

  await logar(page);
  await expect(
    page.getByRole('button', { name: /Maré Baixa/ }).locator('xpath=../button[@aria-pressed]'),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('sem conta o coração não liga, e a biblioteca diz por quê', async ({ page }) => {
  await blockAudius(page);
  await entrarVisitante(page);

  // O rótulo já diz por quê antes de qualquer clique — o botão não fica
  // inerte, senão nem leitor de tela nem teclado chegariam ao aviso.
  await expect(coracao(page, /Maré Baixa/)).toHaveAttribute(
    'aria-label',
    'Curtir — exige entrar na conta',
  );

  await coracao(page, /Maré Baixa/).click();
  await expect(page.getByText('curtir exige entrar na conta')).toBeVisible();
  await expect(coracao(page, /Maré Baixa/)).toHaveAttribute('aria-pressed', 'false');

  await page.keyboard.press('3');
  await expect(page.getByText('curtidas exigem login.')).toBeVisible();
});

test('curtida feita sem rede fica na fila e sobe quando a rede volta', async ({ page }) => {
  await blockAudius(page);
  await logar(page);

  // Sem este caminho a curtida sumiria em silêncio: o boot seguinte traz a
  // lista do servidor e sobrescreve o que ficou só aqui.
  // O handler fica numa variável porque `unroute` sem ele removeria TODAS as
  // rotas do padrão — inclusive a do `stubApi`, e aí o PATCH escaparia para o
  // `vite preview` e a fila nunca subiria. É a armadilha do 405 outra vez.
  const semRede = (route: Route) => route.abort();
  await page.route('**/api/likes', semRede);
  await coracao(page, /Maré Baixa/).click();
  await expect(coracao(page, /Maré Baixa/)).toHaveAttribute('aria-pressed', 'true');

  // Fechar e reabrir sem rede: a fila está no disco, não na memória.
  await page.reload();
  await skipSplash(page);
  await expect(coracao(page, /Maré Baixa/)).toHaveAttribute('aria-pressed', 'true', {
    timeout: 10000,
  });

  // A rede volta e a fila sobe. O reload sozinho NÃO provaria isso: o espelho
  // local desenharia o mesmo coração. Quem prova é sair e entrar de novo, que
  // apaga o espelho e deixa só o que o servidor tiver.
  await page.unroute('**/api/likes', semRede);
  await page.reload();
  await skipSplash(page);
  await expect(coracao(page, /Maré Baixa/)).toHaveAttribute('aria-pressed', 'true', {
    timeout: 10000,
  });

  await page.keyboard.press('5');
  await page.getByRole('button', { name: /sair/ }).click();
  await expect(page).toHaveURL(/login/);
  await logar(page);
  await expect(coracao(page, /Maré Baixa/)).toHaveAttribute('aria-pressed', 'true');
});

test('os recortes aparecem na ordem curtidas, playlists, historico, acervo, compartilhadas, offline', async ({
  page,
}) => {
  await blockAudius(page);
  await logar(page);
  await page.keyboard.press('3');

  // A alternativa (um regex com os nomes de hoje) deixaria de cobrir a ordem no
  // dia em que entrasse um chip novo: ele seria filtrado fora e a asserção
  // passaria sem ver. Daí o seletor ser "todo chip de recorte".
  const chips = page.getByRole('button', { name: /^--[a-zç]+$/ });
  await expect(chips).toHaveText([
    '--curtidas',
    '--playlists',
    '--historico',
    '--acervo',
    '--compartilhadas',
    '--offline',
  ]);
});

test('sem conta, nem --acervo nem --compartilhadas são desenhados', async ({ page }) => {
  await blockAudius(page);
  await entrarVisitante(page);
  await page.keyboard.press('3');

  // Os dois dependem da mesma rota, que sem sessão responde 401: o chip seria
  // uma lista sempre vazia.
  await expect(page.getByRole('button', { name: '--curtidas' })).toBeVisible();
  await expect(page.getByRole('button', { name: '--offline' })).toBeVisible();
  await expect(page.getByRole('button', { name: '--acervo' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '--compartilhadas' })).toHaveCount(0);
  // E o histórico, que é da conta como as curtidas — mas ao contrário delas
  // nem o chip aparece: não há gesto que um visitante pudesse fazer ali.
  await expect(page.getByRole('button', { name: '--historico' })).toHaveCount(0);
});

test('a faixa de outra conta fica em --compartilhadas, e a minha em --acervo', async ({ page }) => {
  await blockAudius(page);
  semearCompartilhada(page);
  await logar(page);
  await page.keyboard.press('3');

  // `--acervo` é o padrão de quem tem conta: só a minha.
  await expect(page.getByRole('button', { name: '--acervo' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: /Fita Caseira/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Vinda de Longe/ })).toHaveCount(0);

  await page.getByRole('button', { name: '--compartilhadas' }).click();
  await expect(page).toHaveURL('/library/shared');
  await expect(page.getByRole('button', { name: /Vinda de Longe/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Fita Caseira/ })).toHaveCount(0);

  // E a linha diz de quem é — a única marca de dono que existe: a minha
  // não leva nenhuma.
  await expect(page.getByText('[de mayumi]')).toBeVisible();

  // O prompt escreve o chip em português, não o id `shared` da URL.
  await expect(page.getByText('ondas ls --compartilhadas')).toBeVisible();
});

test('a faixa compartilhada toca, porque ouvir e ser dono são direitos diferentes', async ({
  page,
}) => {
  await blockAudius(page);
  semearCompartilhada(page);
  await logar(page);
  await page.keyboard.press('3');
  await page.getByRole('button', { name: '--compartilhadas' }).click();

  await page.getByRole('button', { name: /Vinda de Longe/ }).click();
  // O rodapé passa a anunciar a faixa: se `/audio` tivesse dado 404 — o que
  // acontece se a API conferir "sou o dono" em vez de "posso ouvir" —, a tela
  // ficaria no aviso de stream indisponível.
  await expect(page.getByText('Vinda de Longe').first()).toBeVisible();
});

test('o segmento da biblioteca é um endereço, e o voltar anda entre eles', async ({ page }) => {
  await blockAudius(page);
  await entrarVisitante(page);

  await page.keyboard.press('3');
  await expect(page).toHaveURL('/library');
  // Visitante não tem acervo, então o padrão de `/library` aqui é `--curtidas`
  // (com conta é `--acervo`, exercitado no teste do login).
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

// ── playlists ──────────────────────────────────────────────────────────────

/** A barra de seleção, ligada. */
const marcadas = (page: Page) => page.getByText(/^\d+ marcadas?$/);

/**
 * Segura a linha — a única porta do modo de seleção no toque.
 *
 * Pressão de verdade (down, espera, up) e não um evento sintético: o que se
 * quer provar inclui o `click` que o navegador dispara no `pointerup`, e que o
 * `useToqueLongo` tem de engolir.
 */
async function segurar(page: Page, alvo: Locator) {
  // `hover()` e não um `boundingBox()` lido à mão: ele espera a linha ficar
  // ESTÁVEL antes de mover o ponteiro. Com a caixa lida na hora, uma lista que
  // ainda estava montando movia a linha entre a leitura e o clique, e a pressão
  // caía no vazio — que foi exatamente o que aconteceu aqui.
  await alvo.hover();
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
}

test('marcar faixas e criar uma playlist com elas', async ({ page }) => {
  await blockAudius(page);
  await logar(page);
  await page.keyboard.press('3');

  // Sem o modo ligado, a lista é uma lista: a porta é o botão (ou `v`).
  // Não há botão na tela: a porta é segurar a linha. O gesto já entra marcando
  // a faixa que foi segurada — a primeira pressão tem de ter feito algo.
  await segurar(page, page.getByRole('button', { name: /Fita Caseira/ }));
  await expect(marcadas(page)).toHaveText('1 marcada');

  // Com o modo ligado, um toque simples passa a MARCAR em vez de tocar.
  await page.getByRole('button', { name: /Fita Caseira/ }).click();
  await expect(marcadas(page)).toHaveText('0 marcadas');
  await page.getByRole('button', { name: /Fita Caseira/ }).click();
  await expect(marcadas(page)).toHaveText('1 marcada');
  // A calha vira a caixa de marcação, no lugar do número.
  await expect(page.getByRole('button', { name: /^\[x\] Fita Caseira/ })).toBeVisible();

  await page.getByRole('button', { name: '[+ playlist]' }).click();
  await page.getByLabel('nome da playlist').fill('treino');
  await page.getByRole('button', { name: '[ok]' }).click();

  // Adicionar sai do modo e diz o que aconteceu.
  await expect(page.getByText('1 faixa → treino')).toBeVisible();
  await expect(marcadas(page)).toHaveCount(0);

  await page.getByRole('button', { name: '--playlists' }).click();
  await expect(page).toHaveURL('/library/playlists');
  // Era `1 playlists`: a contagem do prompt não tinha singular, e a
  // pluralização do catálogo passou a ter.
  await expect(page.getByText('# 1 playlist')).toBeVisible();
  await expect(page.getByRole('button', { name: /treino 1 faixa/ })).toBeVisible();
});

test('a playlist toca na ordem dela, e o `n` não sai dela', async ({ page }) => {
  await blockAudius(page);
  // Duas faixas do catálogo demo, na ordem INVERSA à da lista: é o que prova
  // que a playlist manda na ordem, e não o catálogo.
  semearPlaylist(page, 'disco', ['demo3', 'demo0']);
  await logar(page);
  await page.goto('/library/playlists/semeada-disco');

  await expect(page.getByText('ondas ls --playlist="disco"')).toBeVisible();
  const linhas = page.getByRole('button', { name: /^\d\d / });
  await expect(linhas.first()).toContainText('Fio de Cobre');
  await expect(linhas.nth(1)).toContainText('Maré Baixa');

  // Toca a primeira DA PLAYLIST e pede a próxima: antes da fila, `n` iria para
  // a vizinha no catálogo (demo4), que nem está nesta tela.
  await linhas.first().click();
  await expect(page.getByText('Fio de Cobre').first()).toBeVisible();
  await page.keyboard.press('n');
  await expect(page.getByRole('button', { name: /^▶ Maré Baixa/ })).toBeVisible();
  // E dá a volta DENTRO da playlist, em vez de seguir pelo catálogo.
  await page.keyboard.press('n');
  await expect(page.getByRole('button', { name: /^▶ Fio de Cobre/ })).toBeVisible();
});

test('J move a faixa na playlist, e a ordem sobrevive ao reload', async ({ page }) => {
  await blockAudius(page);
  semearPlaylist(page, 'disco', ['demo0', 'demo3']);
  await logar(page);
  await page.goto('/library/playlists/semeada-disco');

  const linhas = page.getByRole('button', { name: /^\d\d / });
  await expect(linhas.first()).toContainText('Maré Baixa');

  // `J` move a linha do CURSOR, então primeiro o cursor vai para ela.
  await page.keyboard.press('j');
  await page.keyboard.press('J');
  await expect(linhas.first()).toContainText('Fio de Cobre');

  // O reload é a prova: a ordem otimista da tela só sobrevive se o PATCH
  // chegou ao servidor (ver o debounce em `app/playlists.ts`).
  await page.waitForTimeout(600);
  await page.reload();
  await skipSplash(page);
  await expect(page.getByRole('button', { name: /Fio de Cobre/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^\d\d / }).first()).toContainText(
    'Fio de Cobre',
  );
});

test('tirar faixa da playlist, e a playlist que fica vazia diz o que fazer', async ({ page }) => {
  await blockAudius(page);
  semearPlaylist(page, 'disco', ['demo0']);
  await logar(page);
  await page.goto('/library/playlists/semeada-disco');

  await segurar(page, page.getByRole('button', { name: /Maré Baixa/ }));
  await page.getByRole('button', { name: '[− playlist]' }).click();

  await expect(page.getByText('faixa tirada da playlist')).toBeVisible();
  await expect(page.getByText(/segure uma faixa na lista \(ou tecle v\)/)).toBeVisible();
});

test('a faixa que saiu do catálogo não vira playlist vazia em silêncio', async ({ page }) => {
  await blockAudius(page);
  // Dois ids que não existem em catálogo nenhum: é o que acontece com faixa
  // pública guardada na playlist depois que ela sai do trending.
  semearPlaylist(page, 'antiga', ['faixa-que-saiu', 'outra-que-saiu']);
  await logar(page);
  await page.goto('/library/playlists/semeada-antiga');

  // O prompt confessa a diferença entre o que ela tem e o que ela mostra.
  await expect(page.getByText('# 0 itens · 2 fora da lista')).toBeVisible();
  // `não estão`, no plural: a frase antiga grudava o sujeito plural num verbo
  // no singular, porque só a contagem variava.
  await expect(
    page.getByText(/2 faixas desta playlist não estão no catálogo de hoje/),
  ).toBeVisible();
});

test('renomear e apagar playlist, com dois toques para apagar', async ({ page }) => {
  await blockAudius(page);
  semearPlaylist(page, 'treino', []);
  await logar(page);
  await page.goto('/library/playlists');

  await page.getByRole('button', { name: '[renomear]' }).click();
  await page.getByLabel('novo nome').fill('corrida');
  await page.getByRole('button', { name: '[ok]' }).click();
  await expect(page.getByRole('button', { name: /corrida/ })).toBeVisible();

  // Um toque só mostra a pergunta; apagar não dá para desfazer.
  await page.getByRole('button', { name: '[apagar]' }).click();
  await expect(page.getByText('apagar?')).toBeVisible();
  await page.getByRole('button', { name: '[não]' }).click();
  await expect(page.getByRole('button', { name: /corrida/ })).toBeVisible();

  await page.getByRole('button', { name: '[apagar]' }).click();
  await page.getByRole('button', { name: '[sim]' }).click();
  await expect(page.getByText('nenhuma playlist')).toBeVisible();
});

test('nome repetido é recusado com a frase do servidor', async ({ page }) => {
  await blockAudius(page);
  semearPlaylist(page, 'treino', []);
  await logar(page);
  await page.keyboard.press('3');

  await segurar(page, page.getByRole('button', { name: /Fita Caseira/ }));
  await page.getByRole('button', { name: '[+ playlist]' }).click();
  await page.getByRole('button', { name: /nova playlist/ }).click();
  await page.getByLabel('nome da playlist').fill('TREINO');
  await page.getByRole('button', { name: '[ok]' }).click();

  // A mensagem é a do servidor, em pt-BR e dita para ser lida — e as marcas
  // continuam lá, porque a pessoa só precisa escolher outro nome.
  await expect(page.getByText('já existe uma playlist com esse nome')).toBeVisible();
  await expect(marcadas(page)).toHaveText('1 marcada');
});

test('as playlists vêm do servidor, e sair da conta as leva', async ({ page }) => {
  await blockAudius(page);
  semearPlaylist(page, 'veio-do-servidor', ['demo0']);
  await logar(page);
  await page.goto('/library/playlists');
  await expect(page.getByRole('button', { name: /veio-do-servidor/ })).toBeVisible();

  await page.keyboard.press('5');
  await page.getByRole('button', { name: /sair/ }).click();
  await expect(page).toHaveURL(/login/);

  // Espelho que ficasse apareceria para a próxima conta que entrasse neste
  // navegador. Entrar de novo as traz, porque elas estão no servidor.
  await logar(page);
  await page.goto('/library/playlists');
  await expect(page.getByRole('button', { name: /veio-do-servidor/ })).toBeVisible();
});

test('sem conta, --playlists não é desenhado', async ({ page }) => {
  await blockAudius(page);
  await entrarVisitante(page);
  await page.keyboard.press('3');

  // Playlist é da conta: o chip seria uma lista sempre vazia, como `--acervo`.
  await expect(page.getByRole('button', { name: '--playlists' })).toHaveCount(0);

  // E o gesto não liga o modo: ele diz por quê, como o coração faz.
  await page.keyboard.press('1');
  await segurar(page, page.getByRole('button', { name: /Maré Baixa/ }).first());
  await expect(page.getByText('playlists exigem entrar na conta')).toBeVisible();
  await expect(marcadas(page)).toHaveCount(0);
});

test('v marca pelo teclado, x alterna a linha do cursor e Esc desiste', async ({ page }) => {
  await blockAudius(page);
  semearPlaylist(page, 'treino', []);
  await logar(page);
  await page.keyboard.press('3');

  // `v` liga o modo marcando a linha do cursor; sem cursor, apenas liga.
  await page.keyboard.press('j');
  await page.keyboard.press('v');
  await expect(marcadas(page)).toHaveText('1 marcada');

  // `x` alterna a mesma linha.
  await page.keyboard.press('x');
  await expect(marcadas(page)).toHaveText('0 marcadas');
  await page.keyboard.press('x');
  await expect(marcadas(page)).toHaveText('1 marcada');

  // `a` abre o seletor, `j`/`k` andam e `enter` escolhe.
  await page.keyboard.press('a');
  await expect(page.getByRole('dialog', { name: 'ondas +add-to-playlist' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'ondas +add-to-playlist' })).toBeHidden();

  // Esc na lista é a última camada: desiste da seleção e limpa as marcas.
  await expect(marcadas(page)).toHaveText('1 marcada');
  await page.keyboard.press('Escape');
  await expect(marcadas(page)).toHaveCount(0);
});

test('o seletor diz quantas das marcadas já estão em cada playlist', async ({ page }) => {
  await blockAudius(page);
  semearPlaylist(page, 'treino', ['demo0']);
  await logar(page);
  await page.keyboard.press('3');
  await page.getByRole('button', { name: '--curtidas' }).click();
  // Marca pela home, onde a faixa demo1 aparece.
  await page.keyboard.press('1');

  await segurar(page, page.getByRole('button', { name: /Maré Baixa/ }));
  await page.getByRole('button', { name: '[+ playlist]' }).click();

  // Sem este número, adicionar de novo pareceria não ter feito nada: o servidor
  // ignora a repetição.
  await expect(page.getByRole('button', { name: /treino 1 já está aqui/ })).toBeVisible();
});


test('segurar marca uma vez só, e não toca a música', async ({ page }) => {
  await blockAudius(page);
  await logar(page);
  await page.keyboard.press('1');

  // Nada tocando antes: o botão do rodapé só existe com faixa carregada.
  await expect(page.getByRole('button', { name: 'Abrir player' })).toHaveCount(0);

  await segurar(page, page.getByRole('button', { name: /Maré Baixa/ }));
  await expect(marcadas(page)).toHaveText('1 marcada');
  await expect(page.getByRole('button', { name: 'Abrir player' })).toHaveCount(0);

  // A segunda pressão é a que prova o engolidor de clique.
  //
  // Na primeira, a barra nasce e empurra a lista para baixo: o dedo solta sobre
  // outra linha, o navegador não acha um alvo comum e nenhum clique chega ao
  // botão — o acerto é por acidente de layout. Com o modo JÁ ligado nada se
  // move, o `click` do `pointerup` cai na mesma linha, e sem engoli-lo ele
  // DESMARCARIA o que a pressão acabou de marcar.
  await segurar(page, page.getByRole('button', { name: /Concreto Molhado/ }));
  await expect(marcadas(page)).toHaveText('2 marcadas');
});

test('com a marcação desligada, a lista começa logo abaixo dos chips', async ({ page }) => {
  await blockAudius(page);
  await logar(page);
  await page.keyboard.press('3');

  // Antes, um `[selecionar]` sozinho ocupava uma linha inteira entre os dois:
  // 36px da linha mais dois `gap` de 14px do `.content`, 64px de altura acima
  // da primeira faixa numa tela onde a lista já começa na metade.
  const chips = page.locator('[class*="segments"]').first();
  const primeira = page.getByRole('button', { name: /^01 / }).first();
  const abaixo = await chips.boundingBox();
  const acima = await primeira.boundingBox();
  expect(abaixo).not.toBeNull();
  expect(acima).not.toBeNull();
  expect(acima!.y - (abaixo!.y + abaixo!.height)).toBeLessThan(30);

  // E a barra não existe enquanto o modo está desligado — nem vazia.
  await expect(page.getByRole('button', { name: '[sair]' })).toHaveCount(0);
});

/**
 * Os três idiomas.
 *
 * pt-BR mora na raiz e é coberto por todo o resto deste arquivo — estes testes
 * cuidam do que só existe com prefixo: `/en`, `/es`, o `<html lang>`, a troca
 * e a preferência.
 */
test('/en abre em inglês, com o vocabulário de terminal junto', async ({ page }) => {
  await page.goto('/en/login');
  await skipSplash(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('button', { name: /continue as a visitor/ }).click();

  // A prosa e o vocabulário de CLI mudam juntos: é a decisão do commit.
  await expect(page.getByText('~/trending').first()).toBeVisible();
  await expect(page.getByText(/ondas trending --genre=all/)).toBeVisible();

  // E a URL continua em inglês, como sempre foi — o prefixo só se soma a ela.
  // Regex: no estreito a aba é só ícone e o nome acessível perde o dígito.
  await page.getByRole('button', { name: /~\/library/ }).click();
  await expect(page).toHaveURL(/\/en\/library/);
});

test('/es abre em espanhol e o número usa vírgula', async ({ page }) => {
  await page.goto('/es/login');
  await skipSplash(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await page.getByRole('button', { name: /continuar como visitante — solo pistas gratis/ }).click();
  await expect(page.getByText('~/tendencias').first()).toBeVisible();
});

test('o seletor troca de idioma, e a escolha sobrevive ao reload', async ({ page }) => {
  // A troca é feita no LOGIN de propósito: é a primeira tela de quem não fala
  // português, e trocar navega — o modo visitante não atravessa uma navegação
  // (nunca atravessou um reload).
  await page.goto('/login');
  await skipSplash(page);

  // Pelo botão e não pela tecla: no celular não há teclado, e esta é
  // justamente a porta que precisa existir para quem chega sem entender a tela.
  await page.getByRole('button', { name: 'Trocar idioma' }).click();
  const janela = page.getByRole('dialog', { name: 'ondas +list-langs' });
  await expect(janela).toBeVisible();
  // Cada idioma aparece no PRÓPRIO idioma: quem abriu isto porque não entende
  // a tela não procuraria por "inglês".
  await expect(janela.getByText('english')).toBeVisible();
  await expect(janela.getByText('español')).toBeVisible();

  await janela.getByRole('button', { name: /english/ }).click();
  await expect(page).toHaveURL(/\/en\/login/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: /continue as a visitor/ })).toBeVisible();

  // E a raiz passa a mandar para o inglês, que é o que prova que a escolha
  // foi guardada — e não só que a URL mudou.
  await page.goto('/');
  // `/en/login` e não `/en/`: sem sessão o app manda para o login, como sempre
  // fez. O que este teste afirma é que o PREFIXO foi aplicado — isto é, que a
  // escolha foi guardada e relida, e não só que a URL mudou no clique.
  await expect(page).toHaveURL(/\/en\//);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('a janela de atalhos lista a tecla do idioma', async ({ page }) => {
  await page.goto('/login');
  await skipSplash(page);
  await page.getByRole('button', { name: /continuar como visitante/ }).click();
  await page.keyboard.press('?');
  const atalhos = page.getByRole('dialog', { name: 'ondas --help' });
  await expect(atalhos.getByText('idioma')).toBeVisible();
  await expect(atalhos.getByText('8', { exact: true })).toBeVisible();
});

/**
 * O INCIDENTE DE 2026-11-03: a música parava sozinha depois de umas três
 * faixas, com a tela bloqueada.
 *
 * A causa não era o áudio: era `navigator.onLine`. O Android põe o Wi-Fi para
 * dormir com a tela bloqueada, o navegador passa a jurar que não há rede, e o
 * app tratava isso como verdade — toda faixa não baixada deixava de ser
 * "tocável", `stepIndex` não achava destino e `onEnded` devolvia `stop`.
 * Silêncio, sem recado e sem pular. O smart buffer é que dava a folga de uma
 * faixa (ele baixa a próxima), e é por isso que dava "umas três" em vez de
 * parar na primeira.
 *
 * O teste força a mentira — `onLine` falso com as rotas respondendo — e exige
 * que o fim da faixa continue levando à seguinte. A faixa do acervo serve um
 * WAV de 4s de verdade, então o `ended` aqui é um fim de faixa real.
 */
test('o navegador dizer que não há rede não para a música no fim da faixa', async ({ page }) => {
  await logar(page);

  // Todo toast que passar, guardado: o do item 3 é a AUSÊNCIA de um aviso, e
  // isso não se afirma num instante — o buffer dispara depois do play.
  await page.evaluate(() => {
    const vistos: string[] = [];
    (window as unknown as { __toasts: string[] }).__toasts = vistos;
    new MutationObserver(() => {
      const el = document.querySelector('[role="status"]');
      const texto = el?.textContent?.trim();
      if (texto && texto !== vistos[vistos.length - 1]) vistos.push(texto);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });

  // A mentira do Wi-Fi dormindo: `onLine` falso, rede funcionando.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
  });
  // O aviso não promete mais "apenas faixas [off]", porque não é mais verdade:
  // faixa que não está no aparelho continua tocável.
  await expect(page.getByRole('status')).toHaveText(/rede desconectada$/);

  // Tocar já é a primeira coisa que o veto impedia: antes isto parava em
  // "sem rede — faixa não está no aparelho" sem nem tentar a rede.
  await page.getByRole('button', { name: /^01 Fita Caseira/ }).click();
  await expect(page.getByText('Fita Caseira — Eu Mesmo')).toBeVisible();

  // O WAV tem 4s: aqui o `ended` é de verdade. A faixa seguinte é a primeira
  // do catálogo demo, e ela tem de entrar na linha do player.
  await expect(page.getByText('Maré Baixa — Lia Sombra')).toBeVisible({ timeout: 15000 });

  // ITEM 3: o smart buffer é automático, então ele não fala. A checagem de
  // rede vinha ANTES do uso do `silent` e ele piscava "conecte-se para
  // baixar" sozinho, no meio de uma música que estava tocando normalmente.
  const toasts = await page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts);
  expect(toasts.join(' | ')).not.toMatch(/conecte-se para baixar/);
});

/**
 * O outro lado do mesmo conserto: quando a rede cai DE VERDADE, o player não
 * pode desfilar pelo catálogo nem morrer calado.
 *
 * Tirar o veto de `navigator.onLine` deixou o `<audio>` ser o juiz de quem tem
 * rede — e isso precisa de teto, porque `engine.on('error')` chama `step(1)`,
 * que chama `play`, que erra de novo. Sem contador, uma queda de rede faria o
 * app atravessar a lista inteira sozinho piscando toast.
 *
 * Com só o acervo ligado, a fila tem uma faixa e a falha é de fato seguida: as
 * faixas demo são playback simulado e nunca erram, então elas salvariam a
 * sequência e esconderiam o teto.
 */
test('falha seguida para o player com recado, e a rede voltando retoma', async ({ page }) => {
  await logar(page);

  await abrirConta(page);
  const conta = page.getByRole('dialog', { name: 'ondas whoami' });
  await conta.getByRole('button', { name: /catálogo/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByText('fonte: só o acervo')).toBeVisible();

  // O áudio passa a falhar — é o que uma queda de rede faz com o elemento.
  await page.unroute('**/api/acervo/*/audio');
  await page.route('**/api/acervo/*/audio', (route) => route.abort());

  await page.getByRole('button', { name: /^01 Fita Caseira/ }).click();

  // O player desiste DIZENDO. Antes, `onEnded` punha `playing: false` e calava
  // — era o telefone no bolso ficando em silêncio sem explicação.
  await expect(page.getByRole('status')).toHaveText(/toque em play/, { timeout: 20000 });

  // E a volta da rede retoma de onde parou, sem ninguém pedir.
  await page.unroute('**/api/acervo/*/audio');
  await page.route('**/api/acervo/*/audio', async (route) =>
    route.fulfill({ status: 200, contentType: 'audio/wav', body: wavDeSilencio(4) }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('status')).toHaveText(/retomando/, { timeout: 10000 });
});

/**
 * A abertura não pode rodar duas vezes quando o app troca de versão.
 *
 * A recarga em si é necessária: ao ativar, o SW novo apaga os chunks do build
 * velho (`cleanupOutdatedCaches`), e a página que continuasse rodando pediria
 * arquivo que não existe mais. O que não era aceitável é ela chegar sem aviso —
 * com `registerType: 'autoUpdate'` a biblioteca recarregava sozinha ~1s depois
 * de abrir, e quem via o app pela segunda vez num dia de deploy via a abertura
 * inteira duas vezes. Pior: com uma música tocando, a recarga calava o player.
 *
 * Forçar um SW novo aqui exigiria um segundo build, então o teste ataca a
 * decisão e não o encanamento: a marca em `sessionStorage` é exatamente o
 * estado em que a página chega depois da recarga de versão (ver
 * `app/atualizacao.ts`), e é ela que a abertura consulta.
 */
test('a recarga que troca de versão não repete a abertura', async ({ page }) => {
  const abertura = page.getByRole('button', { name: 'pular abertura' });

  // Boot normal: a abertura aparece.
  await page.goto('/');
  await expect(abertura).toBeVisible();
  await skipSplash(page);
  await expect(page.getByText('ondas — login')).toBeVisible();

  // A marca que `atualizacao.ts` grava imediatamente antes de mandar o
  // `SKIP_WAITING` — quem recarrega é o listener de `controlling` da
  // biblioteca, e ele não avisa antes.
  await page.evaluate(() => sessionStorage.setItem('ondas:recarga-de-versao', '1'));
  await page.reload();

  // O login visível prova que o React montou; a abertura e as rotas montam no
  // mesmo quadro, então aqui a decisão da abertura já está tomada — não é uma
  // asserção que passa por a tela ainda estar vazia.
  await expect(page.getByText('ondas — login')).toBeVisible();

  // `toHaveCount(0)` com janela curta, e NÃO `toBeHidden`: a abertura fecha
  // sozinha no teto de 4,5s, então um `toBeHidden` com os 5s de padrão passa
  // mesmo quando ela rodou inteira. Foi exatamente assim que este teste passou
  // contra o código antigo na primeira tentativa de falsificá-lo.
  await expect(abertura).toHaveCount(0, { timeout: 1000 });

  // E a marca vale para UMA carga: o boot seguinte tem abertura de novo.
  await page.reload();
  await expect(abertura).toBeVisible();
});

/**
 * O INCIDENTE DE 2026-11-05: a música parou na troca de faixa, com a tela
 * desligada — de novo, e já com o conserto de 2026-11-03 instalado.
 *
 * Aquele conserto tirou a mentira do `navigator.onLine` do caminho de TOCAR e
 * a deixou no de BAIXAR. Com o Wi-Fi dormindo, o smart buffer se desligava
 * sozinho: a próxima faixa deixava de ir para o aparelho e cada troca passava
 * a apostar que o rádio acordaria a tempo. Na quarta troca não acordou.
 *
 * Estes quatro testes cobrem as quatro peças do conserto. Todos reprovam com
 * o código anterior.
 */

/** Grava todo toast que passar: `TOAST_MS` é 3,2s e as esperas aqui são maiores. */
async function gravarToasts(page: Page) {
  await page.evaluate(() => {
    const vistos: string[] = [];
    (window as unknown as { __toasts: string[] }).__toasts = vistos;
    new MutationObserver(() => {
      const el = document.querySelector('[role="status"]');
      const texto = el?.textContent?.trim();
      if (texto && texto !== vistos[vistos.length - 1]) vistos.push(texto);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

const toastsVistos = (page: Page) =>
  page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts.join(' | '));

/**
 * Faz o navegador recusar o `play()` as próximas `n` vezes.
 *
 * É a recusa de verdade: uma promise rejeitada, não um evento de `error` no
 * elemento — o elemento fica intacto e a chamada seguinte toca normalmente.
 * Tem de ser `addInitScript`, porque o `new Audio()` nasce no boot do app.
 */
async function armarRecusaDePlay(page: Page) {
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.play;
    const w = window as unknown as { __recusar: number; __tentativas: number };
    w.__recusar = 0;
    w.__tentativas = 0;
    HTMLMediaElement.prototype.play = function () {
      w.__tentativas++;
      if (w.__recusar > 0) {
        w.__recusar--;
        return Promise.reject(new DOMException('recusado pelo teste', 'NotAllowedError'));
      }
      return original.call(this);
    };
  });
}

const recusar = (page: Page, n: number) =>
  page.evaluate((v) => ((window as unknown as { __recusar: number }).__recusar = v), n);
const tentativas = (page: Page) =>
  page.evaluate(() => (window as unknown as { __tentativas: number }).__tentativas);

/** Só o acervo na lista: as faixas demo são playback simulado e nunca recusam. */
async function soOAcervo(page: Page) {
  await abrirConta(page);
  await page
    .getByRole('dialog', { name: 'ondas whoami' })
    .getByRole('button', { name: /catálogo/ })
    .click();
  await page.keyboard.press('Escape');
  await expect(page.getByText('fonte: só o acervo')).toBeVisible();
}

/** A mentira do Wi-Fi dormindo: `onLine` falso, rede funcionando. */
async function mentirQueNaoHaRede(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
  });
  await expect(page.getByRole('status')).toHaveText(/rede desconectada$/);
}

test('o buffer não acredita no navegador quando ele diz que não há rede', async ({ page }) => {
  semearCompartilhada(page);
  // Contar os pedidos da SEGUNDA faixa: o stream da primeira também bate em
  // `/audio`, então o filtro é pelo id. Isto é a prova direta de que foi a
  // rede, e não um marcador qualquer na tela.
  const pedidos: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('33333333')) pedidos.push(r.url());
  });

  await logar(page);
  await soOAcervo(page);
  await mentirQueNaoHaRede(page);

  await page.getByRole('button', { name: /^01 Fita Caseira/ }).click();

  // A segunda faixa entra no aparelho SOZINHA, com o navegador jurando que
  // não há rede. Antes, `download()` saía na checagem e nem um pedido saía.
  await expect(page.getByRole('button', { name: 'Remover do aparelho' })).toBeVisible({
    timeout: 15000,
  });
  expect(pedidos.length).toBeGreaterThan(0);
});

test('uma recusa do navegador não cala a música', async ({ page }) => {
  await armarRecusaDePlay(page);
  await logar(page);
  await gravarToasts(page);
  // O WAV padrão tem 4s e o `ended` cairia no meio das asserções.
  await page.unroute('**/api/acervo/*/audio');
  await page.route('**/api/acervo/*/audio', async (route) =>
    route.fulfill({ status: 200, contentType: 'audio/wav', body: wavDeSilencio(30) }),
  );

  await recusar(page, 1);
  await page.getByRole('button', { name: /^01 Fita Caseira/ }).click();

  // O player insiste e o som sai. Antes, uma recusa só já virava PAUSE com
  // recado — e, com a tela desligada, silêncio até alguém pegar o telefone.
  await expect(page.getByText('PLAY', { exact: true })).toBeVisible({ timeout: 10000 });
  expect(await tentativas(page)).toBe(2);
  expect(await toastsVistos(page)).not.toMatch(/não começou/);
});

/**
 * A outra metade do par: insistir TEM FIM. Sem isto, alguém "consertaria" a
 * insistência com um `while (true)` e o teste acima continuaria passando.
 */
test('insistir tem fim, e o player para dizendo', async ({ page }) => {
  await armarRecusaDePlay(page);
  await logar(page);
  await gravarToasts(page);

  await recusar(page, 99);
  await page.getByRole('button', { name: /^01 Fita Caseira/ }).click();

  await expect(page.getByRole('status')).toHaveText(/toque em play/, { timeout: 20000 });
  // Quatro: a primeira, mais uma por espera de `ESPERAS_ATE_DESISTIR`.
  expect(await tentativas(page)).toBe(4);
  await expect(page.getByText('PAUSE', { exact: true })).toBeVisible();
});

/**
 * E o que faltava em 2026-11-05: a pendência nascia presa ao evento `online`,
 * que a página em segundo plano não recebe. Quando a tela acende,
 * `navigator.onLine` já voltou a ser `true` e nenhum `online` dispara — a
 * música ficava esperando um aviso que nunca vinha.
 */
test('voltar para a tela retoma o que a rede não retomou', async ({ page }) => {
  await armarRecusaDePlay(page);
  await logar(page);
  await gravarToasts(page);
  await page.unroute('**/api/acervo/*/audio');
  await page.route('**/api/acervo/*/audio', async (route) =>
    route.fulfill({ status: 200, contentType: 'audio/wav', body: wavDeSilencio(30) }),
  );

  const verPagina = (estado: 'hidden' | 'visible') =>
    page.evaluate((v) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
      document.dispatchEvent(new Event('visibilitychange'));
    }, estado);

  await recusar(page, 99);
  await page.getByRole('button', { name: /^01 Fita Caseira/ }).click();
  await expect(page.getByRole('status')).toHaveText(/toque em play/, { timeout: 15000 });

  // O telefone no bolso, e depois a tela acendendo. `navigator.onLine` é
  // `true` o tempo todo e NENHUM evento `online` é despachado: é isso que
  // prova que quem retomou foi a visibilidade.
  await verPagina('hidden');
  await recusar(page, 0);
  await verPagina('visible');

  await expect(page.getByText('PLAY', { exact: true })).toBeVisible({ timeout: 10000 });
  expect(await toastsVistos(page)).toMatch(/continuando de onde parou/);
});

/* ── O marcador é da conta ────────────────────────────────────────────────── */

/**
 * Onde a conta parou — a última faixa e o segundo dela — mora no servidor e
 * segue a pessoa para qualquer aparelho. O que estes testes travam:
 *
 * - a retomada ARMA o player (faixa na tela, pausada no segundo certo) e nunca
 *   faz som sozinha;
 * - o aparelho que só foi aberto não escreve nada, para não passar por cima do
 *   que outro aparelho está ouvindo;
 * - sair da conta não deixa o ponto de parada para a próxima.
 */

/** O tempo corrente na linha do player: o texto logo depois do título. */
const tempoDoPlayer = (page: Page) =>
  page.getByRole('button', { name: 'Abrir player' }).locator('xpath=following-sibling::span[1]');

/** As escritas do marcador que chegaram ao servidor de mentira. */
const puts = (page: Page) => ouvidoSemeado.get(page)!.puts;

const verPagina = (page: Page, estado: 'hidden' | 'visible') =>
  page.evaluate((v) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
    document.dispatchEvent(new Event('visibilitychange'));
  }, estado);

test('abrir com a conta traz o player pausado onde ela parou', async ({ page }) => {
  await blockAudius(page);
  // Semeado ANTES do login: é o "outro aparelho". Nada disto está no disco
  // desta página.
  semearMarcador(page, 'demo0', 42, 214);
  await logar(page);

  // A faixa está no player, parada no segundo do marcador.
  await expect(page.getByText('Maré Baixa — Lia Sombra')).toBeVisible();
  await expect(tempoDoPlayer(page)).toHaveText(/^0:42/);
  await expect(page.getByText('PAUSE', { exact: true })).toBeVisible();
  // E a linha dela na lista é a corrente, com a marca de pausa.
  await expect(page.getByRole('button', { name: /^‖ Maré Baixa/ })).toBeVisible();

  // Nunca toca sozinho: o tempo não anda, e o modo não sai de PAUSE.
  await page.waitForTimeout(1500);
  await expect(tempoDoPlayer(page)).toHaveText(/^0:42/);
  await expect(page.getByText('PAUSE', { exact: true })).toBeVisible();

  // Um toque e continua DALI — não do começo.
  await page.getByRole('button', { name: 'Tocar', exact: true }).click();
  await expect(page.getByText('PLAY', { exact: true })).toBeVisible();
  await expect(tempoDoPlayer(page)).toHaveText(/^0:4[4-9]/, { timeout: 10000 });
});

test('a retomada vale para áudio de verdade, e não só para o tempo na tela', async ({ page }) => {
  await blockAudius(page);
  // Meio minuto de WAV: o fixture padrão tem 4s, e ali qualquer posição cai
  // nas pontas que a retomada devolve ao começo de propósito.
  //
  // E servido com `Range`, como o R2 e o Audius servem. Sem `206` o Chrome
  // trata o recurso como não posicionável e devolve o `currentTime` a zero —
  // o teste falharia por causa do stub, e não do que ele quer provar.
  const wav = wavDeSilencio(30);
  await page.unroute('**/api/acervo/*/audio');
  await page.route('**/api/acervo/*/audio', async (route) => {
    const pedido = /bytes=(\d+)-(\d*)/.exec(route.request().headers()['range'] ?? '');
    const ini = pedido ? Number(pedido[1]) : 0;
    const fim = pedido?.[2] ? Number(pedido[2]) : wav.length - 1;
    return route.fulfill({
      status: pedido ? 206 : 200,
      contentType: 'audio/wav',
      headers: {
        'accept-ranges': 'bytes',
        ...(pedido ? { 'content-range': `bytes ${ini}-${fim}/${wav.length}` } : {}),
      },
      body: wav.subarray(ini, fim + 1),
    });
  });
  semearMarcador(page, ACERVO[0]!.id, 12, 30);
  await logar(page, /^‖ Fita Caseira/);

  await expect(page.getByText('Fita Caseira — Eu Mesmo')).toBeVisible();
  await expect(tempoDoPlayer(page)).toHaveText(/^0:12/);
  await page.getByRole('button', { name: 'Tocar', exact: true }).click();
  await expect(page.getByText('PLAY', { exact: true })).toBeVisible({ timeout: 10000 });

  // `0:13` ou mais só aparece se o ELEMENTO de áudio foi posicionado: o `0:12`
  // inicial é pintado pela store, mas daí em diante quem manda no relógio é o
  // `timeupdate`. Sem o seek guardado até o áudio carregar (o `seekPendente`
  // do motor), o próximo valor seria `0:00`.
  await expect(tempoDoPlayer(page)).toHaveText(/^0:1[3-9]/, { timeout: 10000 });
});

test('o link de uma faixa vence o marcador', async ({ page }) => {
  await blockAudius(page);
  semearMarcador(page, 'demo0', 42, 214);
  await logar(page);
  await expect(page.getByText('Maré Baixa — Lia Sombra')).toBeVisible();

  // Um boot novo, já com a sessão, direto no endereço de OUTRA faixa: quem
  // abriu o link pediu aquela música, e o marcador não disputa com isso.
  await page.goto(LINK_LOFI);
  await skipSplash(page);
  await expect(page.getByRole('heading', { name: 'Fio de Cobre' })).toBeVisible();
  await expect(page.getByText('Maré Baixa — Lia Sombra')).toHaveCount(0);

  // E vence mesmo quando o link não leva a lugar nenhum. É o caso em que só a
  // regra segura: com a faixa do link tocando, o player já está ocupado e o
  // marcador não teria onde entrar; aqui o player está VAZIO, e sem a regra a
  // faixa de ontem apareceria armada por baixo de um endereço que fala de outra.
  await page.goto('/t/faixa-que-nao-existe-zzz999');
  await skipSplash(page);
  await expect(page.getByText(/faixa não encontrada/)).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1000);
  await expect(page.getByText('Maré Baixa — Lia Sombra')).toHaveCount(0);
});

test('ouvir grava o marcador na conta, e pausar grava onde parou', async ({ page }) => {
  await blockAudius(page);
  await logar(page);
  expect(puts(page)).toHaveLength(0);

  await page.getByRole('button', { name: /Maré Baixa/ }).click();
  await expect(page.getByText('PLAY', { exact: true })).toBeVisible();
  // O primeiro som já sobe: é quando "estou ouvindo isto" vira verdade para o
  // outro aparelho.
  await expect.poll(() => puts(page).length).toBeGreaterThan(0);
  expect(puts(page)[0]).toMatchObject({ trackId: 'demo0' });

  await expect(tempoDoPlayer(page)).toHaveText(/^0:0[2-9]/, { timeout: 10000 });
  const antes = puts(page).length;
  await page.getByRole('button', { name: 'Pausar', exact: true }).click();
  await expect(page.getByText('PAUSE', { exact: true })).toBeVisible();

  // E a pausa sobe sem esperar o intervalo de quinze segundos.
  await expect.poll(() => puts(page).length).toBeGreaterThan(antes);
  const ultimo = puts(page).at(-1)!;
  expect(ultimo.trackId).toBe('demo0');
  expect(ultimo.pos).toBeGreaterThanOrEqual(2);
});

test('o aparelho que só foi aberto não escreve por cima de ninguém', async ({ page }) => {
  await blockAudius(page);
  semearMarcador(page, 'demo0', 42, 214);
  await logar(page);
  await expect(tempoDoPlayer(page)).toHaveText(/^0:42/);

  // Arrastar a barra com o player armado só muda de onde o play vai partir…
  await page.keyboard.press('ArrowRight');
  // …e a página saindo de cena é o momento em que a PWA grava o que tem na
  // memória. Com o player armado ela não tem nada SEU para gravar: a posição
  // na tela é a que veio do servidor.
  await verPagina(page, 'hidden');
  await page.waitForTimeout(800);
  await verPagina(page, 'visible');
  await page.waitForTimeout(400);

  // É a outra metade da regra de conflito (a primeira é do servidor, que
  // ignora escrita velha): um celular esquecido aberto não pode carimbar como
  // "agora" a faixa que recebeu ontem.
  expect(puts(page)).toHaveLength(0);
});

test('sair da conta não deixa o ponto de parada para a próxima', async ({ page }) => {
  await blockAudius(page);
  semearMarcador(page, 'demo0', 42, 214);
  await logar(page);
  await expect(page.getByText('Maré Baixa — Lia Sombra')).toBeVisible();

  // Sair leva a faixa armada: ela é a última coisa que a conta ouviu, parada
  // na barra de baixo à vista de quem pegar o aparelho.
  await page.keyboard.press('5');
  await page.getByRole('button', { name: /sair/ }).click();
  await expect(page).toHaveURL(/login/);

  // A conta que entra agora nunca ouviu nada. Se o espelho do IndexedDB
  // tivesse ficado, o player apareceria armado com a faixa de quem saiu.
  //
  // Sem recarregar a página (`preencherLogin`, e não `logar`): um boot novo
  // limparia o espelho sozinho, e o teste passaria sem provar o logout.
  ouvidoSemeado.get(page)!.marcador = null;
  await preencherLogin(page);
  await page.waitForTimeout(1000);
  await expect(page.getByText('Maré Baixa — Lia Sombra')).toHaveCount(0);
  expect(puts(page)).toHaveLength(0);
});

/**
 * A PWA instalada não "abre": ela fica viva por dias no celular. Sem perguntar
 * ao servidor na volta para a tela, quem ouviu no desktop pegaria o telefone e
 * veria a faixa de ontem — o recurso funcionaria só para quem fecha o app.
 */
test('voltar para a tela traz o que foi ouvido em outro aparelho', async ({ page }) => {
  await blockAudius(page);
  await logar(page);
  await expect(page.getByText('Maré Baixa — Lia Sombra')).toHaveCount(0);

  /** Adianta o relógio da página: a volta só pergunta uma vez por minuto. */
  const passarDoisMinutos = () =>
    page.evaluate(() => {
      const agora = Date.now.bind(Date);
      Date.now = () => agora() + 120_000;
    });
  const sairEVoltar = async () => {
    await verPagina(page, 'hidden');
    await verPagina(page, 'visible');
  };

  // Enquanto esta página estava em segundo plano, outro aparelho ouviu.
  ouvidoSemeado.get(page)!.marcador = { trackId: 'demo0', pos: 42, dur: 214, em: Date.now() };
  await passarDoisMinutos();
  await sairEVoltar();

  await expect(page.getByText('Maré Baixa — Lia Sombra')).toBeVisible();
  await expect(tempoDoPlayer(page)).toHaveText(/^0:42/);
  await expect(page.getByText('PAUSE', { exact: true })).toBeVisible();

  // Mas nunca por cima de música: com som saindo, o que está tocando AQUI é o
  // mais novo que existe, por mais que o servidor diga outra coisa.
  await page.getByRole('button', { name: 'Tocar', exact: true }).click();
  await expect(page.getByText('PLAY', { exact: true })).toBeVisible();
  ouvidoSemeado.get(page)!.marcador = {
    trackId: 'demo3',
    pos: 90,
    dur: 172,
    em: Date.now() + 3_600_000,
  };
  await passarDoisMinutos();
  await sairEVoltar();
  await page.waitForTimeout(800);
  await expect(page.getByText('Maré Baixa — Lia Sombra')).toBeVisible();
  await expect(page.getByText('PLAY', { exact: true })).toBeVisible();
});

/* ── O histórico ──────────────────────────────────────────────────────────── */

test('a faixa ouvida entra em --historico, e a que só foi iniciada não', async ({ page }) => {
  await blockAudius(page);
  await logar(page);

  // Dois toques seguidos: a primeira faixa toca um instante e é trocada. Ela
  // não foi ouvida, e histórico não é lista de cliques.
  await page.getByRole('button', { name: /Último Trem/ }).click();
  await expect(page.getByText('PLAY', { exact: true })).toBeVisible();
  // O WAV do acervo tem 4s; faixa curta conta na metade.
  await page.getByRole('button', { name: /^01 Fita Caseira/ }).click();
  await expect
    .poll(() => ouvidoSemeado.get(page)!.historico.map((it) => it.trackId), { timeout: 15000 })
    .toEqual([ACERVO[0]!.id]);

  await page.keyboard.press('3');
  await page.getByRole('button', { name: '--historico' }).click();
  await expect(page).toHaveURL(/\/library\/history$/);
  await expect(page.getByText('ondas ls --historico')).toBeVisible();
  await expect(page.getByRole('button', { name: /Fita Caseira/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Último Trem/ })).toHaveCount(0);
});

test('o histórico mostra a faixa que saiu do catálogo, e limpar pede dois toques', async ({
  page,
}) => {
  await blockAudius(page);
  // A primeira não existe em catálogo nenhum desta página: é a faixa do
  // trending de ontem. Só o retrato guardado no servidor a desenha.
  semearHistorico(
    page,
    { trackId: 'saiu99', titulo: 'Faixa Que Saiu', artista: 'Alguém de Ontem', dur: 200 },
    { trackId: 'demo0', titulo: 'Maré Baixa', artista: 'Lia Sombra', dur: 214 },
  );
  await logar(page);
  await page.goto('/library/history');
  await skipSplash(page);

  // Na ordem do histórico, e não na do catálogo.
  const linhas = page.getByRole('button', { name: /^(··|\d\d|‖|▶) / });
  await expect(linhas.first()).toContainText('Faixa Que Saiu');
  await expect(linhas.nth(1)).toContainText('Maré Baixa');

  // A de fora não tem número na calha (ela não tem lugar no catálogo) nem
  // botão de baixar — o retrato não tem áudio para guardar.
  const deFora = page.getByRole('button', { name: /^·· Faixa Que Saiu/ });
  await expect(deFora).toBeVisible();
  await expect(deFora.locator('xpath=..').getByRole('button', { name: 'Baixar para offline' })).toHaveCount(0);
  await expect(
    page
      .getByRole('button', { name: /Maré Baixa/ })
      .locator('xpath=..')
      .getByRole('button', { name: 'Baixar para offline' }),
  ).toHaveCount(1);

  // Tocá-la abre o endereço da faixa, que é quem sabe buscá-la por id.
  await deFora.click();
  await expect(page).toHaveURL(/\/t\/.*saiu99$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/library\/history$/);

  // Limpar não se desfaz: dois toques, e o primeiro pode ser recusado.
  await page.getByRole('button', { name: '[limpar histórico]' }).click();
  await expect(page.getByText('limpar o histórico?')).toBeVisible();
  await page.getByRole('button', { name: '[não]' }).click();
  await expect(deFora).toBeVisible();

  await page.getByRole('button', { name: '[limpar histórico]' }).click();
  await page.getByRole('button', { name: '[sim]' }).click();
  await expect(page.getByText('vazio — o que você ouvir aparece aqui.')).toBeVisible();
  expect(ouvidoSemeado.get(page)!.historico).toHaveLength(0);
  // Sem o que limpar, o botão sai.
  await expect(page.getByRole('button', { name: '[limpar histórico]' })).toHaveCount(0);
});

test('limpar o histórico não apaga o ponto de onde continuar', async ({ page }) => {
  await blockAudius(page);
  semearMarcador(page, 'demo0', 42, 214);
  semearHistorico(page, { trackId: 'demo0', titulo: 'Maré Baixa', artista: 'Lia Sombra', dur: 214 });
  await logar(page);
  await page.goto('/library/history');
  await skipSplash(page);

  await page.getByRole('button', { name: '[limpar histórico]' }).click();
  await page.getByRole('button', { name: '[sim]' }).click();
  await expect(page.getByText('vazio — o que você ouvir aparece aqui.')).toBeVisible();

  // "Esquecer o que ouvi" e "perder onde parei" são dois pedidos.
  await expect(page.getByText('Maré Baixa — Lia Sombra')).toBeVisible();
  await expect(tempoDoPlayer(page)).toHaveText(/^0:42/);
  expect(ouvidoSemeado.get(page)!.marcador).toMatchObject({ trackId: 'demo0', pos: 42 });
});

test('/en chama o recorte de --history', async ({ page }) => {
  await blockAudius(page);
  await logar(page);
  await page.goto('/en/library/history');
  await skipSplash(page);
  await expect(page.getByRole('button', { name: '--history' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByText('empty — what you listen to shows up here.')).toBeVisible();
});

/* ── Os recortes pelo teclado ─────────────────────────────────────────────── */

/** O chip do recorte, pelo nome que a tela mostra. */
const chip = (page: Page, nome: string) => page.getByRole('button', { name: nome, exact: true });

/** Digita na linha de comando e confirma. */
async function comando(page: Page, texto: string) {
  await page.keyboard.press(':');
  await page.getByLabel('Ir para a faixa pelo número').fill(texto);
  await page.keyboard.press('Enter');
}

test('`]` e `[` andam pelos recortes e dão a volta nas pontas', async ({ page }) => {
  await blockAudius(page);
  await logar(page);
  await page.keyboard.press('3');
  await expect(page).toHaveURL('/library');
  // Com conta `/library` é `--acervo`, o quarto dos seis.
  await expect(chip(page, '--acervo')).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press(']');
  await expect(page).toHaveURL('/library/shared');
  await expect(chip(page, '--compartilhadas')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press(']');
  await expect(page).toHaveURL('/library/offline');
  // A ponta direita: o próximo é o primeiro.
  await page.keyboard.press(']');
  await expect(page).toHaveURL('/library/liked');
  await expect(chip(page, '--curtidas')).toHaveAttribute('aria-pressed', 'true');

  // E a ponta esquerda, para o outro lado.
  await page.keyboard.press('[');
  await expect(page).toHaveURL('/library/offline');
  await page.keyboard.press('[');
  await expect(page).toHaveURL('/library/shared');

  // Push, como o clique no chip: o voltar anda entre recortes.
  await page.goBack();
  await expect(page).toHaveURL('/library/offline');
});

test('sem conta, `]` só alterna entre os dois chips desenhados', async ({ page }) => {
  await blockAudius(page);
  await entrarVisitante(page);
  await page.keyboard.press('3');
  await expect(chip(page, '--curtidas')).toHaveAttribute('aria-pressed', 'true');

  // Se o teclado andasse pela fileira inteira, cairia em `--playlists`, que
  // ninguém desenhou para o visitante.
  await page.keyboard.press(']');
  await expect(page).toHaveURL('/library/offline');
  await page.keyboard.press(']');
  await expect(page).toHaveURL('/library/liked');
  await page.keyboard.press('[');
  await expect(page).toHaveURL('/library/offline');
});

test('de dentro de uma playlist, `]` sai para o chip vizinho', async ({ page }) => {
  await blockAudius(page);
  semearPlaylist(page, 'noite', ['demo0']);
  await logar(page);
  await page.goto('/library/playlists');
  await page.getByRole('button', { name: /noite/ }).click();
  await expect(page).toHaveURL('/library/playlists/semeada-noite');

  await page.keyboard.press(']');
  await expect(page).toHaveURL('/library/history');
});

test('fora da biblioteca os colchetes não fazem nada', async ({ page }) => {
  await blockAudius(page);
  await entrarVisitante(page);

  await page.keyboard.press(']');
  await page.keyboard.press('[');
  await expect(page).toHaveURL('/');

  // Nem com o player cheio por cima, que é outra rota.
  await page.getByRole('button', { name: /Maré Baixa/ }).click();
  await page.keyboard.press('0');
  await expect(page).toHaveURL(LINK_DEMO);
  await page.keyboard.press(']');
  await expect(page).toHaveURL(LINK_DEMO);
});

test('o chip marcado pelo teclado entra na vista quando a fileira rola', async ({ page }) => {
  await blockAudius(page);
  // Estreito de propósito, nos dois projetos: é só onde a fileira transborda.
  await page.setViewportSize({ width: 360, height: 740 });
  await logar(page);
  await page.goto('/library/liked');
  const offline = chip(page, '--offline');
  await expect(chip(page, '--curtidas')).toHaveAttribute('aria-pressed', 'true');

  const dentroDaFileira = () =>
    offline.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const f = el.parentElement!.getBoundingClientRect();
      return r.left >= f.left - 1 && r.right <= f.right + 1;
    });
  // O estado inicial tem de tornar o teste relevante: com o chip já à vista,
  // ele passaria sem rolagem nenhuma.
  expect(await dentroDaFileira()).toBe(false);

  await page.keyboard.press('[');
  await expect(page).toHaveURL('/library/offline');
  await expect.poll(dentroDaFileira).toBe(true);
});

test('os colchetes valem com AltGr, e continuam do navegador com Cmd', async ({ page }) => {
  await blockAudius(page);
  await entrarVisitante(page);
  await page.keyboard.press('3');
  await expect(page).toHaveURL('/library');

  // Tipo estreito de propósito: `KeyboardEventInit` carrega `view: Window`, que
  // o Playwright não sabe serializar.
  const tecla = (extra: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }) =>
    page.evaluate(
      (init) => window.dispatchEvent(new KeyboardEvent('keydown', { key: ']', ...init })),
      extra,
    );

  // Cmd+] é "avançar" do navegador: não é nosso.
  await tecla({ metaKey: true });
  // Ctrl sozinho também não.
  await tecla({ ctrlKey: true });
  await expect(page).toHaveURL('/library');

  // AltGr no Windows chega como Ctrl+Alt — é como `]` sai num teclado espanhol.
  await tecla({ ctrlKey: true, altKey: true });
  await expect(page).toHaveURL('/library/offline');
});

test('`:nome` leva ao recorte, de qualquer tela', async ({ page }) => {
  await blockAudius(page);
  await logar(page);
  await expect(page).toHaveURL('/');

  await comando(page, 'historico');
  await expect(page).toHaveURL('/library/history');
  await expect(chip(page, '--historico')).toHaveAttribute('aria-pressed', 'true');

  // Um prefixo que só casa um recorte basta, e o `--` do chip é aceito.
  await comando(page, 'off');
  await expect(page).toHaveURL('/library/offline');
  await comando(page, '--acervo');
  await expect(page).toHaveURL('/library/archive');

  // O que não leva a lugar nenhum diz por quê, e a tela fica onde estava.
  await comando(page, 'xyz');
  await expect(page.getByText('recorte "xyz" não existe')).toBeVisible();
  await expect(page).toHaveURL('/library/archive');
  await comando(page, 'c');
  await expect(page.getByText('"c" casa com --curtidas, --compartilhadas')).toBeVisible();
  await expect(page).toHaveURL('/library/archive');
});

test('sem conta, `:acervo` avisa que é só com conta e não navega', async ({ page }) => {
  await blockAudius(page);
  await entrarVisitante(page);

  await comando(page, 'acervo');
  await expect(page.getByText('--acervo é só com conta')).toBeVisible();
  await expect(page).toHaveURL('/');

  // Os dois que o visitante vê continuam valendo.
  await comando(page, 'offline');
  await expect(page).toHaveURL('/library/offline');
});

test('/en entende o nome do recorte em inglês', async ({ page }) => {
  await blockAudius(page);
  await logar(page);
  await page.goto('/en/');
  await skipSplash(page);

  await page.keyboard.press(':');
  await page.getByLabel('Go to a track by number').fill('history');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/en/library/history');
  await expect(chip(page, '--history')).toHaveAttribute('aria-pressed', 'true');
});

test('a janela de atalhos lista os dois caminhos até um recorte', async ({ page }) => {
  await blockAudius(page);
  await entrarVisitante(page);
  await page.keyboard.press('?');
  const ajuda = page.getByRole('dialog', { name: 'ondas --help' });
  await expect(ajuda.getByText('[/]', { exact: true })).toBeVisible();
  await expect(ajuda.getByText('recorte anterior e próximo, na biblioteca')).toBeVisible();
  await expect(ajuda.getByText(':recorte', { exact: true })).toBeVisible();
});

test('enter não toca uma faixa que ficou no recorte anterior', async ({ page }) => {
  await blockAudius(page);
  semearPlaylist(page, 'noite', ['demo0']);
  await logar(page);
  await page.keyboard.press('3');
  await expect(chip(page, '--acervo')).toHaveAttribute('aria-pressed', 'true');

  // O cursor marca uma linha de `--acervo`…
  await page.keyboard.press('j');
  await expect(cursor(page)).toContainText('Fita Caseira');

  // …e o teclado leva ao índice de `--playlists`, que não lista faixa nenhuma.
  await page.keyboard.press('[');
  await page.keyboard.press('[');
  await expect(page).toHaveURL('/library/playlists');
  await expect(page.getByRole('button', { name: /noite/ })).toBeVisible();

  // Aqui não há linha marcada na tela: `enter` e `j` não têm sobre o que agir.
  await page.keyboard.press('Enter');
  await page.keyboard.press('j');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Abrir player' })).toHaveCount(0);
});

/* ── A aparência é da conta ───────────────────────────────────────────────── */

const tema = (page: Page) => page.locator('html');

/** Escolhe um tema pelo seletor, como quem usa. */
async function escolherTema(page: Page, nome: RegExp) {
  await page.getByRole('button', { name: 'Trocar tema' }).click();
  await page
    .getByRole('dialog', { name: 'ondas +list-themes' })
    .getByRole('button', { name: nome })
    .click();
}

/**
 * Espera passar o debounce da subida, e mais um pouco.
 *
 * Só para afirmar AUSÊNCIA — "nada subiu". Para presença usa-se `expect.poll`,
 * que não precisa de relógio.
 */
const passarODebounce = (page: Page) => page.waitForTimeout(1500);

/** "Outro aparelho": o mesmo navegador sem nada do que este guardou de aparência. */
async function esquecerAparenciaLocal(page: Page) {
  await page.evaluate(() => {
    localStorage.removeItem('ondas-theme');
    localStorage.removeItem('ondas:idioma');
  });
}

test('o tema da conta chega no login, e este aparelho não escreve de volta', async ({ page }) => {
  await blockAudius(page);
  semearPrefs(page, { tema: 'nord' });
  await logar(page);
  await expect(tema(page)).toHaveAttribute('data-theme', 'nord');

  // E o boot seguinte já abre nele, pelo espelho que o primeiro paint lê.
  await page.reload();
  await skipSplash(page);
  await expect(tema(page)).toHaveAttribute('data-theme', 'nord');

  // Aplicar o que veio da conta não é gesto: se virasse PATCH, cada boot de
  // cada aparelho escreveria na conta, e o último a abrir venceria sempre.
  await passarODebounce(page);
  expect(contaFalsa(page).patches).toEqual([]);
});

test('conta que nunca escolheu adota o tema que o aparelho já tinha', async ({ page }) => {
  await blockAudius(page);
  await page.goto('/login');
  await skipSplash(page);
  await escolherTema(page, /Dracula/);
  await expect(tema(page)).toHaveAttribute('data-theme', 'dracula');

  // É o dia da atualização: sem isto, quem já usava um tema o perderia para o
  // padrão no primeiro login depois dela.
  await preencherLogin(page);
  await expect.poll(() => contaFalsa(page).prefs).toMatchObject({ tema: 'dracula' });
  await expect(tema(page)).toHaveAttribute('data-theme', 'dracula');
});

test('conta que já escolheu vence o tema do aparelho', async ({ page }) => {
  await blockAudius(page);
  semearPrefs(page, { tema: 'nord' });
  await page.goto('/login');
  await skipSplash(page);
  await escolherTema(page, /Dracula/);
  await expect(tema(page)).toHaveAttribute('data-theme', 'dracula');

  await preencherLogin(page);
  await expect(tema(page)).toHaveAttribute('data-theme', 'nord');
  await passarODebounce(page);
  expect(contaFalsa(page).prefs).toEqual({ tema: 'nord' });
  expect(contaFalsa(page).patches).toEqual([]);
});

test('trocar de tema com conta sobe para ela, e outro aparelho abre igual', async ({ page }) => {
  await blockAudius(page);
  await logar(page);
  await escolherTema(page, /Nord/);
  await expect.poll(() => contaFalsa(page).patches).toEqual([{ tema: 'nord' }]);

  // O reload sozinho não provaria nada: o `localStorage` desenharia o mesmo
  // tema. Sem ele, o que sobra é o que a conta diz.
  await esquecerAparenciaLocal(page);
  await page.reload();
  await skipSplash(page);
  await expect(tema(page)).toHaveAttribute('data-theme', 'nord');
});

test('os ajustes do fundo seguem a conta, e a imagem que não veio vira capa', async ({ page }) => {
  await blockAudius(page);
  semearPrefs(page, { opacity: 0.5, blur: 10, wall: 'imagem' });
  await logar(page);

  // A transparência chegou: o wallpaper existe e o fundo deixou de ser opaco.
  const wallpaper = page.locator('div[aria-hidden="true"][style*="blur("]');
  await expect(wallpaper).toHaveCount(1);
  await expect(wallpaper).toHaveAttribute('style', /blur\(10px\)/);
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--color-bg-a').trim(),
    ),
  ).not.toContain('100%');

  // A conta pede `imagem`, e este aparelho não tem imagem nenhuma — ela não
  // viaja. A tela mostra a capa e o chip aceso diz o mesmo.
  await page.getByRole('button', { name: 'Trocar tema' }).click();
  await expect(page.getByRole('button', { name: '[capa-atual]' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: /^\[?imagem\]?$/ })).toHaveCount(0);

  // E a preferência da conta continua `imagem`: mostrar a capa aqui não pode
  // desfazer a escolha no aparelho que TEM a imagem.
  await passarODebounce(page);
  expect(contaFalsa(page).patches).toEqual([]);
  expect(contaFalsa(page).prefs).toMatchObject({ wall: 'imagem' });
});

test('arrastar a transparência sobe o valor final, e não um pedido por passo', async ({ page }) => {
  await blockAudius(page);
  await logar(page);
  await page.getByRole('button', { name: 'Trocar tema' }).click();
  const slider = page.getByLabel('background-opacity');
  const trilha = (await slider.boundingBox())!;
  const meio = trilha.y + trilha.height / 2;

  for (const fracao of [0.2, 0.35, 0.5, 0.65, 0.8]) {
    await page.mouse.click(trilha.x + trilha.width * fracao, meio);
  }
  const final = Number(await slider.inputValue());

  await expect
    .poll(() => contaFalsa(page).prefs)
    .toMatchObject({ opacity: Math.round(final * 100) / 100 });
  // Cinco passos, e no máximo dois pedidos: sem o debounce seriam cinco.
  expect(contaFalsa(page).patches.length).toBeLessThanOrEqual(2);
});

test('o idioma da conta leva o aparelho para ele, uma vez só', async ({ page }) => {
  await blockAudius(page);
  semearPrefs(page, { idioma: 'en' });
  let boots = 0;
  page.on('request', (req) => {
    if (req.url().endsWith('/api/auth/me')) boots += 1;
  });

  // O login é em português (é o idioma do navegador do teste), e a conta fala
  // inglês: a home já abre sob `/en`.
  await logar(page);
  await expect(page).toHaveURL('/en/');
  await skipSplash(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  // Sem laço: o aparelho guardou o idioma antes de navegar, então o boot
  // seguinte não tem o que corrigir. Um `/me` por boot, e a URL parada.
  await page.waitForTimeout(1000);
  const antes = boots;
  await page.reload();
  await skipSplash(page);
  await page.waitForTimeout(1500);
  expect(boots).toBe(antes + 1);
  await expect(page).toHaveURL('/en/');
  expect(contaFalsa(page).patches).toEqual([]);
});

test('um link em outro idioma abre nele, e não muda o idioma da conta', async ({ page }) => {
  await blockAudius(page);
  semearPrefs(page, { idioma: 'pt-BR' });
  await logar(page);

  // O endereço manda, como sempre mandou: a conta não é consultada para
  // desfazer um link que alguém mandou em inglês.
  await page.goto('/en/');
  await skipSplash(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await passarODebounce(page);
  await expect(page).toHaveURL('/en/');
  // E abrir o link não é escolher: nada sobe.
  expect(contaFalsa(page).patches).toEqual([]);

  await page.goto('/');
  await skipSplash(page);
  await expect(page).toHaveURL('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
});

test('trocar de idioma com conta sobe para ela, e outro aparelho abre nele', async ({ page }) => {
  await blockAudius(page);
  await logar(page);

  await page.getByRole('button', { name: 'Trocar idioma' }).click();
  await page
    .getByRole('dialog', { name: 'ondas +list-langs' })
    .getByRole('button', { name: /español/ })
    .click();
  await expect(page).toHaveURL('/es/');
  await skipSplash(page);
  // Pelo estado, e não pelo pedido: ele parte com `keepalive` de uma página que
  // está saindo, e se morrer no caminho é a fila do boot seguinte que entrega.
  await expect.poll(() => contaFalsa(page).prefs).toMatchObject({ idioma: 'es' });

  // Outro aparelho: sem idioma guardado, navegador em português, na raiz.
  await esquecerAparenciaLocal(page);
  await page.goto('/');
  await expect(page).toHaveURL('/es/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
});

test('tema trocado sem rede fica na fila e sobe quando ela volta', async ({ page }) => {
  await blockAudius(page);
  await logar(page);

  // O handler numa variável, pelo mesmo motivo do teste da curtida: `unroute`
  // sem ele levaria junto a rota do `stubApi`.
  const semRede = (route: Route) => route.abort();
  await page.route('**/api/auth/prefs', semRede);
  await escolherTema(page, /Nord/);
  await passarODebounce(page);
  expect(contaFalsa(page).patches).toEqual([]);

  // Fechar e reabrir ainda sem rede: a fila está no disco, e a conta — que
  // ainda diz "nunca escolhi" — não desfaz o gesto.
  await page.reload();
  await skipSplash(page);
  await expect(tema(page)).toHaveAttribute('data-theme', 'nord');
  await passarODebounce(page);
  expect(contaFalsa(page).patches).toEqual([]);

  await page.unroute('**/api/auth/prefs', semRede);
  await page.reload();
  await skipSplash(page);
  await expect.poll(() => contaFalsa(page).patches).toEqual([{ tema: 'nord' }]);
});

test('contra uma API de antes das preferências, o aparelho segue só local', async ({ page }) => {
  await blockAudius(page);
  apiSemPrefs(page);
  await logar(page);

  await escolherTema(page, /Nord/);
  await expect(tema(page)).toHaveAttribute('data-theme', 'nord');
  await passarODebounce(page);
  // Nem tenta: a rota antiga responderia 400 ao campo que não conhece, e a
  // fila cresceria para sempre.
  expect(contaFalsa(page).recusados).toBe(0);

  await page.reload();
  await skipSplash(page);
  await expect(tema(page)).toHaveAttribute('data-theme', 'nord');
  await passarODebounce(page);
  expect(contaFalsa(page).recusados).toBe(0);
});

test('entrar logo depois de sair não é desfeito pelo logout que ainda corria', async ({ page }) => {
  await blockAudius(page);
  await logar(page);

  // A rede lenta é o que abre a janela: o `[sair]` navega na hora, e o logout
  // fica para trás esperando cada pedido. O `/login` fica de fora do atraso
  // para o defeito não depender de quem chega primeiro — sem a espera no
  // formulário, a sessão nova abria e o logout velho a fechava.
  await page.route('**/api/**', async (route) => {
    if (!route.request().url().includes('/auth/login')) {
      await new Promise((f) => setTimeout(f, 400));
    }
    await route.fallback();
  });

  await page.keyboard.press('5');
  const saiu = page.waitForResponse('**/api/auth/logout');
  await page.getByRole('button', { name: /sair/ }).click();
  await expect(page).toHaveURL(/login/);
  await preencherLogin(page);

  // O logout velho já respondeu, e a conta continua aberta.
  await saiu;
  await expect(page).not.toHaveURL(/login/);
  await expect(page.getByRole('button', { name: /^01 Fita Caseira/ })).toBeVisible();
});

test('sair não muda a cara do app, e a fila de quem saiu não sobe para a próxima conta', async ({
  page,
}) => {
  await blockAudius(page);
  await logar(page);

  // Sem rede para a fila ficar presa: é o único jeito de ela ainda existir na
  // hora do `[sair]`, que tenta subi-la antes.
  const semRede = (route: Route) => route.abort();
  await page.route('**/api/auth/prefs', semRede);
  await escolherTema(page, /Nord/);
  await page.keyboard.press('Escape');

  await page.keyboard.press('5');
  // O `[sair]` navega para o login NA HORA e deixa o `logout` correndo atrás
  // (ele ainda sobe curtidas, ordem e histórico antes de matar o cookie). A
  // URL não prova que ele acabou: é a resposta do `/logout` que prova. Sem
  // esperar por ela, numa máquina lenta a rede abaixo voltava com o logout no
  // meio, e a subida de despedida — que é de quem está saindo, e é certa —
  // era contada como gravação na conta seguinte.
  const saiu = page.waitForResponse('**/api/auth/logout');
  await page.getByRole('button', { name: /sair/ }).click();
  await expect(page).toHaveURL(/login/);
  await saiu;
  // O tema fica: é aparência do aparelho, e apagar piscaria a tela no padrão.
  await expect(tema(page)).toHaveAttribute('data-theme', 'nord');

  // Outra pessoa entra NA MESMA PÁGINA (`preencherLogin`, e não `logar`): um
  // boot novo esconderia a falta da limpeza do logout.
  await page.unroute('**/api/auth/prefs', semRede);
  await preencherLogin(page);
  await passarODebounce(page);
  // O tema de quem saiu continua na tela, mas não é gravado em quem entrou —
  // nem pela fila, nem por uma segunda "primeira adoção".
  expect(contaFalsa(page).patches).toEqual([]);
});

// ── pedido de conta, e a conta administrando a si mesma ─────────────────

test('pedir conta: o pedido fica em análise, e a tela diz como saber o resultado', async ({
  page,
}) => {
  await page.goto('/login');
  await skipSplash(page);

  // A porta é o terceiro botão do login, e o endereço é próprio: é o link que
  // se manda a quem quer experimentar.
  await page.getByRole('button', { name: /pedir uma conta/ }).click();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(page.getByText('ondas — pedir conta')).toBeVisible();
  // Quem pede fica sabendo ANTES que conta nova não envia arquivo.
  await expect(page.getByText(/contas novas ainda não enviam arquivos/)).toBeVisible();

  // A recusa do servidor chega traduzida pelo código, com o número dele.
  await page.getByPlaceholder('como quer ser chamado').fill('Fulana');
  await page.getByPlaceholder('voce@email.com').fill('fulana@exemplo.test');
  await page.getByPlaceholder('8+ caracteres').fill('curta');
  await page.getByRole('button', { name: /enviar o pedido/ }).click();
  await expect(page.getByText('error: senha precisa de 8+ caracteres')).toBeVisible();
  expect(contaFalsa(page).pedidos).toEqual([]);

  await page.getByPlaceholder('8+ caracteres').fill('senha-forte');
  await page.getByPlaceholder(/por que quer experimentar/).fill('quero testar');
  await page.getByPlaceholder(/por que quer experimentar/).press('Enter');

  await expect(page.getByText('pedido recebido — sua conta está em análise.')).toBeVisible();
  await expect(page.getByText(/a tela de login diz se o pedido foi aprovado/)).toBeVisible();
  expect(contaFalsa(page).pedidos).toEqual([
    { name: 'Fulana', email: 'fulana@exemplo.test', password: 'senha-forte', mensagem: 'quero testar' },
  ]);
  // Pedido não é sessão: recarregar não pode abrir o app.
  expect(await page.evaluate(() => document.cookie)).toBe('');

  await page.getByRole('button', { name: /voltar ao login/ }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
});

test('o login diz em que pé está o pedido de conta', async ({ page }) => {
  await page.goto('/login');
  await skipSplash(page);

  await page.getByPlaceholder('voce@email.com').fill('pendente@exemplo.test');
  await page.getByPlaceholder('••••').fill('senha-forte');
  await page.getByRole('button', { name: /entrar — catálogo completo/ }).click();
  await expect(page.getByText(/sua conta ainda está em análise/)).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByPlaceholder('voce@email.com').fill('negada@exemplo.test');
  await page.getByRole('button', { name: /entrar — catálogo completo/ }).click();
  await expect(page.getByText('error: o pedido de conta foi negado')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test('conta sem envio usa a biblioteca, mas não vê o painel de enviar', async ({ page }) => {
  contaFalsa(page).podeEnviar = false;
  await logar(page);

  await page.getByRole('button', { name: /~\/biblioteca/ }).click();
  // A lista está lá — ouvir, curtir e organizar continuam valendo…
  await expect(page.getByRole('button', { name: /^01 Fita Caseira/ })).toBeVisible();
  // …e o botão de envio não existe, em vez de existir e ser recusado.
  await expect(page.getByRole('button', { name: '[+ arquivo]' })).toBeHidden();
  await expect(page.getByText('enviar', { exact: true })).toBeHidden();

  // `ondas whoami` é onde isso está explicado.
  await abrirConta(page);
  const conta = page.getByRole('dialog', { name: 'ondas whoami' });
  await expect(conta.getByText(/ainda não liberado para esta conta/)).toBeVisible();
});

test('conta que pode enviar não ganha a linha de envio no whoami', async ({ page }) => {
  await logar(page);
  await page.getByRole('button', { name: /~\/biblioteca/ }).click();
  await expect(page.getByRole('button', { name: '[+ arquivo]' })).toBeVisible();

  await abrirConta(page);
  const conta = page.getByRole('dialog', { name: 'ondas whoami' });
  await expect(conta.getByText(/ainda não liberado/)).toBeHidden();
});

test('a conta troca o próprio nome e a própria senha', async ({ page }) => {
  await logar(page);
  await abrirConta(page);
  const conta = page.getByRole('dialog', { name: 'ondas whoami' });

  // ── nome ─────────────────────────────────────────────────────────
  await conta.getByRole('button', { name: '[renomear]' }).click();
  const nome = conta.getByRole('textbox', { name: 'nome novo' });
  await expect(nome).toHaveValue('thiago');
  // Esc fecha só o formulário: o painel de conta continua aberto.
  await nome.press('Escape');
  await expect(nome).toBeHidden();
  await expect(conta).toBeVisible();

  await conta.getByRole('button', { name: '[renomear]' }).click();
  await conta.getByRole('textbox', { name: 'nome novo' }).fill('Thiago N');
  await conta.getByRole('textbox', { name: 'nome novo' }).press('Enter');
  await expect(page.getByText('nome salvo')).toBeVisible();
  await expect(conta.getByText('Thiago N', { exact: true })).toBeVisible();
  await expect(conta.getByRole('textbox', { name: 'nome novo' })).toBeHidden();

  // ── senha ────────────────────────────────────────────────────────
  await conta.getByRole('button', { name: '[trocar senha]' }).click();
  await conta.getByLabel('senha atual').fill('nao-e-esta');
  await conta.getByLabel(/senha nova/).fill('outra-senha-1');
  await conta.getByRole('button', { name: '[salvar]' }).click();
  // A recusa aparece NO formulário, e a pessoa continua logada: senha errada
  // não é sessão morta.
  await expect(conta.getByRole('alert')).toHaveText('error: senha atual incorreta');
  await expect(page).not.toHaveURL(/login/);

  await conta.getByLabel('senha atual').fill('senha-forte');
  await conta.getByRole('button', { name: '[salvar]' }).click();
  await expect(page.getByText('senha trocada')).toBeVisible();
  await expect(conta.getByLabel('senha atual')).toBeHidden();
  expect(contaFalsa(page).senha).toBe('outra-senha-1');

  // O nome novo sobrevive ao reload: veio do servidor, não só do store.
  // O painel reabre sozinho — o `?account=1` continua no endereço.
  await page.reload();
  await skipSplash(page);
  await expect(conta.getByText('Thiago N', { exact: true })).toBeVisible();
});

test('apagar a conta pede a senha, e só o aceite do servidor tira a pessoa do app', async ({
  page,
}) => {
  await logar(page);
  await abrirConta(page);
  const conta = page.getByRole('dialog', { name: 'ondas whoami' });

  await conta.getByRole('button', { name: '[apagar a conta]' }).click();
  await expect(conta.getByText(/não tem volta/)).toBeVisible();
  // Sem senha não há o que enviar.
  await expect(conta.getByRole('button', { name: '[apagar de vez]' })).toBeDisabled();

  // Senha errada: nada some, e a pessoa continua onde estava.
  await conta.getByLabel('sua senha, para confirmar').fill('nao-e-esta');
  await conta.getByRole('button', { name: '[apagar de vez]' }).click();
  await expect(conta.getByRole('alert')).toHaveText('error: senha atual incorreta');
  expect(contaFalsa(page).apagada).toBe(false);
  await expect(page).not.toHaveURL(/login/);

  // Desistir fecha o formulário e esquece a senha digitada.
  await conta.getByRole('button', { name: '[cancelar]' }).click();
  await conta.getByRole('button', { name: '[apagar a conta]' }).click();
  await expect(conta.getByLabel('sua senha, para confirmar')).toHaveValue('');

  await conta.getByLabel('sua senha, para confirmar').fill('senha-forte');
  await conta.getByRole('button', { name: '[apagar de vez]' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(contaFalsa(page).apagada).toBe(true);

  // E não sobrou sessão no aparelho: a raiz volta para o login.
  await page.goto('/');
  await skipSplash(page);
  await expect(page).toHaveURL(/\/login$/);
});

test('`ondas --about` leva às issues do projeto para reportar um bug', async ({ page }) => {
  await logar(page);
  await page.keyboard.press('7');
  const sobre = page.getByRole('dialog', { name: 'ondas --about' });
  await expect(sobre).toBeVisible();

  // A linha é só o rótulo e o link: o que informar quem pede é o formulário da
  // issue, e a frase que explicava isso aqui ocupava meia tela no celular.
  await expect(sobre.getByText('bugs', { exact: true })).toBeVisible();
  await expect(sobre.getByText(/abra uma issue/)).toHaveCount(0);
  const link = sobre.getByRole('link', { name: '[reportar um bug]' });
  await expect(link).toHaveAttribute('href', 'https://github.com/thiagotn/ondas/issues/new/choose');
  // Abre em outra aba: reportar não pode custar a música que está tocando.
  await expect(link).toHaveAttribute('target', '_blank');
});
