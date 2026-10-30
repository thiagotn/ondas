import { AuthError } from '../ports/auth.js';
import type { AuthService, Credentials } from '../ports/auth.js';
import type { KeyValueStore } from '../ports/key-value-store.js';
import type { Session, User } from '../types.js';

export const SESSION_KEY = 'user';

const EMAIL_RE = /.+@.+\..+/;
const MIN_PASSWORD = 4;

/**
 * Auth local: as mesmas regras do protótipo (e-mail plausível + senha de 4+),
 * com a sessão persistida no `KeyValueStore`. Serve de implementação de
 * referência até existir um backend — trocar por OAuth/JWT é implementar
 * `AuthService` de novo, sem tocar na UI.
 */
export class LocalAuthService implements AuthService {
  constructor(private readonly store: KeyValueStore) {}

  async login({ email, password }: Credentials): Promise<User> {
    if (!EMAIL_RE.test(email)) throw new AuthError('e-mail inválido');
    if (password.length < MIN_PASSWORD) throw new AuthError('senha precisa de 4+ caracteres');
    // Sem `publico`: ausente já significa "mostra" (`showsPublicCatalog`), e
    // repetir o padrão aqui seria um segundo lugar para mantê-lo.
    const user: User = { name: email.split('@')[0]!.toLowerCase() };
    await this.store.set(SESSION_KEY, user);
    return user;
  }

  async logout(): Promise<void> {
    await this.store.remove(SESSION_KEY);
  }

  async restore(): Promise<Session> {
    return (await this.store.get<User>(SESSION_KEY)) ?? null;
  }

  /**
   * Sem servidor, o espelho É a verdade: grava e devolve.
   *
   * Sessão fora do ar não é caso possível aqui, então não há 401 a tratar — é a
   * diferença que justifica esta implementação continuar existindo ao lado da
   * de rede.
   */
  async setPublico(on: boolean): Promise<User> {
    const atual = await this.store.get<User>(SESSION_KEY);
    if (!atual) throw new AuthError('sem sessão');
    const user: User = { ...atual, publico: on };
    await this.store.set(SESSION_KEY, user);
    return user;
  }
}
