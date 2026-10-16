import { create } from 'zustand';

interface GuestMode {
  /** O usuário escolheu entrar sem conta. Dura só esta sessão, como no protótipo. */
  guest: boolean;
  enterAsGuest(): void;
  leaveGuest(): void;
}

export const useGuestMode = create<GuestMode>((set) => ({
  guest: false,
  enterAsGuest: () => set({ guest: true }),
  leaveGuest: () => set({ guest: false }),
}));
