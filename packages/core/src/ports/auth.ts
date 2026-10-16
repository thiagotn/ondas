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
}
