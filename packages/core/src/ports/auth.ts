import type { Session, User } from '../types.js';

export interface Credentials {
  email: string;
  password: string;
}

export class AuthError extends Error {}

/** Autenticação. `LocalAuthService` implementa as regras do protótipo; OAuth/JWT entram aqui depois. */
export interface AuthService {
  /** Rejeita com `AuthError` e mensagem em pt-BR quando as credenciais não servem. */
  login(credentials: Credentials): Promise<User>;
  logout(): Promise<void>;
  /** Sessão persistida, se houver. */
  restore(): Promise<Session>;
  /**
   * Liga ou desliga o catálogo público desta conta, devolvendo o usuário novo.
   *
   * Fica no serviço de auth, e não num store, porque a preferência é um campo
   * da conta: quem a grava é o servidor, e o espelho local tem de acompanhar —
   * é ele que `restore()` devolve sem rede.
   */
  setPublico(on: boolean): Promise<User>;
}
