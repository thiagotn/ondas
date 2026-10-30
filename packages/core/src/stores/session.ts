import { createStore } from 'zustand/vanilla';
import type { Session, User } from '../types.js';

export interface SessionState {
  user: Session;
  /** `false` até a sessão persistida ser lida — evita piscar a tela de login. */
  restored: boolean;
  setUser(user: Session): void;
  markRestored(user: Session): void;
}

export type SessionStore = ReturnType<typeof createSessionStore>;

export function createSessionStore(initial: Session = null) {
  return createStore<SessionState>((set) => ({
    user: initial,
    restored: false,
    setUser: (user: Session) => set({ user }),
    markRestored: (user: Session) => set({ user, restored: true }),
  }));
}

export function userTag(user: Session): string {
  return user ? '@' + user.name : 'visitante';
}

/**
 * A linha `plano` do painel de conta.
 *
 * Descreve ESTADO, não capacidade — e é por isso que ela olha o `publico`: a
 * linha fica duas acima do botão que desliga o catálogo público, e dizer
 * "catálogo completo" encostado em "catálogo público desligado" é contradição
 * na mesma tela. As mesmas palavras na tela de login continuam valendo, porque
 * ali elas dizem o que a conta PERMITE.
 */
export function planLabel(user: Session): string {
  if (!user) return 'somente faixas grátis';
  return user.publico === false ? 'acervo + offline' : 'catálogo completo + offline';
}

export function whoAmI(user: Session): string {
  return user ? (user as User).name : 'visitante';
}
