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
