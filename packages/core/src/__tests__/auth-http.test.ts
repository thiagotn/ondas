import { describe, expect, it, vi } from 'vitest';
import { HttpAuthService } from '../auth/http.js';
import { AuthError } from '../ports/auth.js';
import type { KeyValueStore } from '../ports/key-value-store.js';

/** KeyValueStore em memória, com registro do que foi escrito e apagado. */
function memoria(inicial?: Record<string, unknown>) {
  const dados = new Map<string, unknown>(Object.entries(inicial ?? {}));
  const store: KeyValueStore & { dados: Map<string, unknown> } = {
    dados,
    get: async <T>(k: string) => dados.get(k) as T | undefined,
    set: async <T>(k: string, v: T) => void dados.set(k, v),
    remove: async (k: string) => void dados.delete(k),
  };
  return store;
}

const resposta = (status: number, corpo?: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (corpo === undefined) throw new Error('sem json');
      return corpo;
    },
  }) as Response;

describe('HttpAuthService.login', () => {
  it('guarda o usuário e devolve o nome', async () => {
    const store = memoria();
    const fetchImpl = vi.fn(async (_rota: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      resposta(200, { name: 'thiagotn', email: 'thiagotn@gmail.com' }),
    );
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    const user = await auth.login({ email: 'thiagotn@gmail.com', password: 'senha-forte' });
    expect(user).toEqual({ name: 'thiagotn' });
    expect(store.dados.get('user')).toEqual({ name: 'thiagotn' });

    const [rota, init] = fetchImpl.mock.calls[0]!;
    expect(rota).toBe('/api/auth/login');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
  });

  it('a mensagem da API chega inteira à tela', async () => {
    const fetchImpl = vi.fn(async () => resposta(401, { error: 'credenciais inválidas' }));
    const auth = new HttpAuthService(memoria(), fetchImpl as unknown as typeof fetch);

    await expect(auth.login({ email: 'a@b.co', password: 'x' })).rejects.toThrow(
      'credenciais inválidas',
    );
    await expect(auth.login({ email: 'a@b.co', password: 'x' })).rejects.toBeInstanceOf(AuthError);
  });

  it('erro sem json ganha mensagem útil em vez de estourar', async () => {
    for (const [status, esperado] of [
      [429, 'muitas tentativas'],
      [502, 'servidor indisponível'],
      [400, 'não foi possível entrar'],
    ] as const) {
      const fetchImpl = vi.fn(async () => resposta(status));
      const auth = new HttpAuthService(memoria(), fetchImpl as unknown as typeof fetch);
      await expect(auth.login({ email: 'a@b.co', password: 'x' })).rejects.toThrow(esperado);
    }
  });

  it('login bem-sucedido sem nada utilizável no corpo é erro, não sessão fantasma', async () => {
    const fetchImpl = vi.fn(async () => resposta(200, { nada: 'aqui' }));
    const auth = new HttpAuthService(memoria(), fetchImpl as unknown as typeof fetch);
    await expect(auth.login({ email: 'a@b.co', password: 'x' })).rejects.toBeInstanceOf(AuthError);
  });
});

describe('HttpAuthService.logout', () => {
  it('limpa o espelho local e avisa o servidor', async () => {
    const store = memoria({ user: { name: 'thiagotn' } });
    const fetchImpl = vi.fn(async (_rota: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      resposta(200, { status: 'ok' }),
    );
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    await auth.logout();
    expect(store.dados.has('user')).toBe(false);
    expect(fetchImpl.mock.calls[0]![0]).toBe('/api/auth/logout');
  });

  it('sem rede, sair ainda funciona na tela', async () => {
    const store = memoria({ user: { name: 'thiagotn' } });
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    await expect(auth.logout()).resolves.toBeUndefined();
    expect(store.dados.has('user')).toBe(false);
  });
});

describe('HttpAuthService.setPublico', () => {
  it('manda o PATCH e regrava o espelho com o valor novo', async () => {
    const store = memoria({ user: { name: 'thiagotn', publico: true } });
    const fetchImpl = vi.fn(async () => resposta(200, { name: 'thiagotn', publico: false }));
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    expect(await auth.setPublico(false)).toEqual({ name: 'thiagotn', publico: false });

    const [rota, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(rota).toBe('/api/auth/prefs');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ publico: false });

    // Regravar é metade do trabalho: é o espelho que `restore()` devolve sem
    // rede, então sem isto o próximo boot offline voltaria à preferência velha.
    expect(store.dados.get('user')).toEqual({ name: 'thiagotn', publico: false });
  });

  it('401 derruba a sessão em vez de parecer um botão instável', async () => {
    const store = memoria({ user: { name: 'thiagotn' } });
    const fetchImpl = vi.fn(async () => resposta(401, { error: 'sessão expirada' }));
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    await expect(auth.setPublico(false)).rejects.toThrow('sessão expirada');
    expect(store.dados.has('user')).toBe(false);
  });
});

describe('HttpAuthService.setPrefs', () => {
  it('manda só o que mudou, e regrava o espelho com o que a conta ficou', async () => {
    const store = memoria({ user: { name: 'thiagotn', prefs: { idioma: 'en' } } });
    const fetchImpl = vi.fn(async () =>
      resposta(200, { name: 'thiagotn', publico: true, prefs: { idioma: 'en', tema: 'nord' } }),
    );
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    const user = await auth.setPrefs({ tema: 'nord' });
    expect(user.prefs).toEqual({ idioma: 'en', tema: 'nord' });

    const [rota, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(rota).toBe('/api/auth/prefs');
    expect(init.method).toBe('PATCH');
    // Só o tema: mandar o resto junto desfaria o idioma trocado em outro
    // aparelho desde o último boot deste.
    expect(JSON.parse(String(init.body))).toEqual({ prefs: { tema: 'nord' } });
    expect(init.keepalive).toBeUndefined();

    // É o espelho que o próximo boot sem rede vai ler.
    expect(store.dados.get('user')).toEqual({
      name: 'thiagotn',
      publico: true,
      prefs: { idioma: 'en', tema: 'nord' },
    });
  });

  it('repassa o keepalive — a troca de idioma recarrega a página em seguida', async () => {
    const store = memoria({ user: { name: 'thiagotn', prefs: {} } });
    const fetchImpl = vi.fn(async () => resposta(200, { name: 'thiagotn', prefs: { idioma: 'es' } }));
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    await auth.setPrefs({ idioma: 'es' }, { keepalive: true });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.keepalive).toBe(true);
  });

  it('401 derruba a sessão, como no catálogo', async () => {
    const store = memoria({ user: { name: 'thiagotn', prefs: {} } });
    const fetchImpl = vi.fn(async () => resposta(401, { error: 'sessão expirada' }));
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    await expect(auth.setPrefs({ tema: 'nord' })).rejects.toThrow('sessão expirada');
    expect(store.dados.has('user')).toBe(false);
  });
});

describe('as preferências na resposta de auth', () => {
  it('conta que nunca escolheu vem com o objeto vazio, e isso NÃO é ausência', async () => {
    const fetchImpl = vi.fn(async () => resposta(200, { name: 'thiagotn', prefs: {} }));
    const auth = new HttpAuthService(memoria({}), fetchImpl as unknown as typeof fetch);
    expect(await auth.restore()).toEqual({ name: 'thiagotn', prefs: {} });
  });

  it('servidor de antes das preferências deixa o campo indefinido', async () => {
    // É a diferença que impede o aparelho de mandar preferência para uma rota
    // que a recusaria: `undefined` é "não há quem guarde", `{}` é "guardo, e
    // está vazio".
    const fetchImpl = vi.fn(async () => resposta(200, { name: 'thiagotn', publico: true }));
    const auth = new HttpAuthService(memoria({}), fetchImpl as unknown as typeof fetch);
    expect((await auth.restore())?.prefs).toBeUndefined();
  });

  it('o que este build não conhece é descartado, e não trocado por um padrão', async () => {
    const fetchImpl = vi.fn(async () =>
      resposta(200, {
        name: 'thiagotn',
        prefs: { tema: 'tema-do-futuro', idioma: 'fr', wall: 'video', opacity: 0.55, blur: 12 },
      }),
    );
    const auth = new HttpAuthService(memoria({}), fetchImpl as unknown as typeof fetch);
    expect((await auth.restore())?.prefs).toEqual({ opacity: 0.55, blur: 12 });
  });

  it('sem rede, o espelho devolve as preferências que a conta tinha', async () => {
    const store = memoria({ user: { name: 'thiagotn', prefs: { tema: 'nord' } } });
    const semRede = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const auth = new HttpAuthService(store, semRede as unknown as typeof fetch);
    expect((await auth.restore())?.prefs).toEqual({ tema: 'nord' });
  });
});

describe('HttpAuthService.restore', () => {
  it('confirma a sessão pelo servidor', async () => {
    const store = memoria({ user: { name: 'antigo' } });
    const fetchImpl = vi.fn(async () => resposta(200, { name: 'thiagotn' }));
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    expect(await auth.restore()).toEqual({ name: 'thiagotn' });
    expect(store.dados.get('user')).toEqual({ name: 'thiagotn' });
  });

  it('lê o `publico` do servidor quando ele vem', async () => {
    const store = memoria({});
    const fetchImpl = vi.fn(async () => resposta(200, { name: 'thiagotn', publico: false }));
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    expect(await auth.restore()).toEqual({ name: 'thiagotn', publico: false });
  });

  it('espelho de versão antiga NÃO ganha o campo, e ausente vale mostrar', async () => {
    // Regressão do pior caso: um espelho gravado antes deste campo existir,
    // mais servidor velho ou sem rede. Se qualquer um destes caminhos
    // preenchesse `publico: false`, o catálogo público desapareceria sozinho
    // para quem nunca pediu isso — e offline, sem como religar. O padrão mora
    // em `showsPublicCatalog`, e só lá.
    const store = memoria({ user: { name: 'thiagotn' } });
    const semCampo = vi.fn(async () => resposta(200, { name: 'thiagotn' }));
    expect(await new HttpAuthService(store, semCampo as unknown as typeof fetch).restore()).toEqual(
      { name: 'thiagotn' },
    );

    const semRede = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await new HttpAuthService(store, semRede as unknown as typeof fetch).restore()).toEqual({
      name: 'thiagotn',
    });
  });

  it('401 derruba a sessão: foi o servidor que disse não', async () => {
    const store = memoria({ user: { name: 'thiagotn' } });
    const fetchImpl = vi.fn(async () => resposta(401, { error: 'sessão expirada' }));
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    expect(await auth.restore()).toBeNull();
    expect(store.dados.has('user')).toBe(false);
  });

  // A PWA é instalada e abre offline: deslogar por falta de rede seria
  // transformar avião em logout.
  it('SEM REDE mantém a sessão local', async () => {
    const store = memoria({ user: { name: 'thiagotn' } });
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    expect(await auth.restore()).toEqual({ name: 'thiagotn' });
    expect(store.dados.get('user')).toEqual({ name: 'thiagotn' });
  });

  it('erro de servidor (500) também mantém: não é "não", é "não sei"', async () => {
    const store = memoria({ user: { name: 'thiagotn' } });
    const fetchImpl = vi.fn(async () => resposta(500));
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    expect(await auth.restore()).toEqual({ name: 'thiagotn' });
    expect(store.dados.get('user')).toEqual({ name: 'thiagotn' });
  });

  it('sem espelho e sem rede, não inventa sessão', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const auth = new HttpAuthService(memoria(), fetchImpl as unknown as typeof fetch);
    expect(await auth.restore()).toBeNull();
  });
});

describe('HttpAuthService: a conta pode enviar arquivo?', () => {
  it('`podeEnviar` do servidor chega ao usuário e ao espelho', async () => {
    const store = memoria();
    const fetchImpl = vi.fn(async () => resposta(200, { name: 'nova', podeEnviar: false }));
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    expect(await auth.login({ email: 'nova@b.co', password: 'senha-forte' })).toEqual({
      name: 'nova',
      podeEnviar: false,
    });
    expect(store.dados.get('user')).toEqual({ name: 'nova', podeEnviar: false });
  });

  it('servidor que não manda o campo não vira "não pode"', async () => {
    const fetchImpl = vi.fn(async () => resposta(200, { name: 'antiga', podeEnviar: 'sim' }));
    const auth = new HttpAuthService(memoria(), fetchImpl as unknown as typeof fetch);

    // Só o booleano entra: o padrão mora num lugar só (`canUpload`).
    expect(await auth.login({ email: 'a@b.co', password: 'senha-forte' })).toEqual({
      name: 'antiga',
    });
  });
});

describe('HttpAuthService.signup', () => {
  const pedido = { name: ' Fulana ', email: 'fulana@b.co', password: 'senha-forte' };

  it('202 é pedido em análise: sem usuário e SEM espelho', async () => {
    const store = memoria();
    const fetchImpl = vi.fn(async () => resposta(202, { status: 'pendente' }));
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    expect(await auth.signup({ ...pedido, mensagem: '  quero testar ' })).toEqual({
      status: 'pendente',
    });
    // Um espelho aqui faria o próximo boot offline abrir "logado" numa conta
    // que o servidor ainda não deixou entrar.
    expect(store.dados.has('user')).toBe(false);

    const [rota, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(rota).toBe('/api/auth/signup');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'Fulana',
      email: 'fulana@b.co',
      password: 'senha-forte',
      mensagem: 'quero testar',
    });
  });

  it('mensagem vazia não vai no corpo', async () => {
    const fetchImpl = vi.fn(async () => resposta(202, { status: 'pendente' }));
    const auth = new HttpAuthService(memoria(), fetchImpl as unknown as typeof fetch);

    await auth.signup({ ...pedido, mensagem: '   ' });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty('mensagem');
  });

  it('201 é conta já aprovada: devolve a sessão e grava o espelho', async () => {
    const store = memoria();
    const fetchImpl = vi.fn(async () => resposta(201, { name: 'Fulana', podeEnviar: false }));
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    expect(await auth.signup(pedido)).toEqual({
      status: 'aprovada',
      user: { name: 'Fulana', podeEnviar: false },
    });
    expect(store.dados.get('user')).toEqual({ name: 'Fulana', podeEnviar: false });
  });

  it('200 com um corpo qualquer não vira "pedido recebido"', async () => {
    // Um proxy no caminho devolvendo 200 não é o servidor aceitando o pedido.
    const store = memoria();
    const fetchImpl = vi.fn(async () => resposta(200, { status: 'pendente' }));
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    await expect(auth.signup(pedido)).rejects.toMatchObject({ codigo: 'resposta_inesperada' });
    expect(store.dados.has('user')).toBe(false);
  });

  it('a recusa chega com o código da API', async () => {
    const fetchImpl = vi.fn(async () =>
      resposta(403, { error: 'cadastro fechado', code: 'cadastro_fechado' }),
    );
    const auth = new HttpAuthService(memoria(), fetchImpl as unknown as typeof fetch);

    await expect(auth.signup(pedido)).rejects.toMatchObject({
      name: 'AuthError',
      codigo: 'cadastro_fechado',
    });
  });

  it('recusa sem json fala de criar conta, e não de entrar', async () => {
    const fetchImpl = vi.fn(async () => resposta(400));
    const auth = new HttpAuthService(memoria(), fetchImpl as unknown as typeof fetch);

    await expect(auth.signup(pedido)).rejects.toMatchObject({ codigo: 'falha_criar_conta' });
  });
});

describe('HttpAuthService: a conta administrando a si mesma', () => {
  it('renomear manda o PATCH e regrava o espelho', async () => {
    const store = memoria({ user: { name: 'thiagotn' } });
    const fetchImpl = vi.fn(async () => resposta(200, { name: 'Thiago' }));
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    expect(await auth.renomear('Thiago')).toEqual({ name: 'Thiago' });
    const [rota, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(rota).toBe('/api/auth/conta');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ name: 'Thiago' });
    expect(store.dados.get('user')).toEqual({ name: 'Thiago' });
  });

  it('trocar a senha manda a atual e a nova', async () => {
    const fetchImpl = vi.fn(async () => resposta(200, { status: 'ok' }));
    const auth = new HttpAuthService(memoria(), fetchImpl as unknown as typeof fetch);

    await auth.trocarSenha('senha-velha', 'senha-nova-1');
    const [rota, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(rota).toBe('/api/auth/senha');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ atual: 'senha-velha', nova: 'senha-nova-1' });
  });

  it('senha atual errada é 403 com código — e a sessão continua de pé', async () => {
    const store = memoria({ user: { name: 'thiagotn' } });
    const fetchImpl = vi.fn(async () =>
      resposta(403, { error: 'senha atual incorreta', code: 'senha_atual_incorreta' }),
    );
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    await expect(auth.trocarSenha('errada', 'senha-nova-1')).rejects.toMatchObject({
      codigo: 'senha_atual_incorreta',
    });
    expect(store.dados.has('user')).toBe(true);
  });

  it('apagar a conta tira o espelho só depois do aceite', async () => {
    const store = memoria({ user: { name: 'thiagotn' } });
    const fetchImpl = vi.fn(async () => resposta(200, { status: 'apagada' }));
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    await auth.apagarConta('senha-forte');
    const [rota, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(rota).toBe('/api/auth/conta/apagar');
    expect(JSON.parse(String(init.body))).toEqual({ senha: 'senha-forte' });
    expect(store.dados.has('user')).toBe(false);
  });

  it('senha errada ao apagar deixa a pessoa logada', async () => {
    const store = memoria({ user: { name: 'thiagotn' } });
    const fetchImpl = vi.fn(async () =>
      resposta(403, { error: 'senha atual incorreta', code: 'senha_atual_incorreta' }),
    );
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    await expect(auth.apagarConta('errada')).rejects.toBeInstanceOf(AuthError);
    expect(store.dados.has('user')).toBe(true);
  });

  it('sem rede ao apagar também: nada saiu do aparelho', async () => {
    const store = memoria({ user: { name: 'thiagotn' } });
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

    await expect(auth.apagarConta('senha-forte')).rejects.toBeInstanceOf(TypeError);
    expect(store.dados.has('user')).toBe(true);
  });

  it('401 em qualquer uma derruba o espelho', async () => {
    for (const acao of [
      (a: HttpAuthService) => a.renomear('x'),
      (a: HttpAuthService) => a.trocarSenha('a', 'senha-nova-1'),
      (a: HttpAuthService) => a.apagarConta('a'),
    ]) {
      const store = memoria({ user: { name: 'thiagotn' } });
      const fetchImpl = vi.fn(async () => resposta(401, { error: 'sessão expirada' }));
      const auth = new HttpAuthService(store, fetchImpl as unknown as typeof fetch);

      await expect(acao(auth)).rejects.toMatchObject({ codigo: 'sessao_expirada' });
      expect(store.dados.has('user')).toBe(false);
    }
  });
});
