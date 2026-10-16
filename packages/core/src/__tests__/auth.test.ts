import { beforeEach, describe, expect, it } from 'vitest';
import { LocalAuthService, SESSION_KEY } from '../auth/local.js';
import { AuthError } from '../ports/auth.js';
import type { KeyValueStore } from '../ports/key-value-store.js';

function memoryStore(): KeyValueStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T) {
      data.set(key, value);
    },
    async remove(key: string) {
      data.delete(key);
    },
  };
}

describe('LocalAuthService', () => {
  let store: ReturnType<typeof memoryStore>;
  let auth: LocalAuthService;

  beforeEach(() => {
    store = memoryStore();
    auth = new LocalAuthService(store);
  });

  it('autentica e persiste o usuário derivado do e-mail', async () => {
    const user = await auth.login({ email: 'Thiago.TN@Email.com', password: 'senha' });
    expect(user).toEqual({ name: 'thiago.tn' });
    expect(store.data.get(SESSION_KEY)).toEqual({ name: 'thiago.tn' });
  });

  it('recusa e-mail inválido', async () => {
    await expect(auth.login({ email: 'thiago', password: 'senha' })).rejects.toThrow(AuthError);
    await expect(auth.login({ email: 'thiago@local', password: 'senha' })).rejects.toThrow(
      'e-mail inválido',
    );
    expect(store.data.size).toBe(0);
  });

  it('recusa senha curta', async () => {
    await expect(auth.login({ email: 'a@b.co', password: 'abc' })).rejects.toThrow(
      'senha precisa de 4+ caracteres',
    );
  });

  it('restaura e encerra a sessão', async () => {
    expect(await auth.restore()).toBeNull();
    await auth.login({ email: 'a@b.co', password: 'abcd' });
    expect(await auth.restore()).toEqual({ name: 'a' });
    await auth.logout();
    expect(await auth.restore()).toBeNull();
  });
});
