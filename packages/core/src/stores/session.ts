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

export function planLabel(user: Session): string {
  return user ? 'catálogo completo + offline' : 'somente faixas grátis';
}

export function whoAmI(user: Session): string {
  return user ? (user as User).name : 'visitante';
}
