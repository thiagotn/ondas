import { create } from 'zustand';
import { SHOW_SPLASH } from './services';

interface SplashState {
  visible: boolean;
  /** Muda a cada exibição: é a chave que reinicia o cronômetro do componente. */
  run: number;
  close(): void;
  replay(): void;
}

/**
 * Abertura do app. A flag `SHOW_SPLASH` decide se ela aparece no boot; o replay
 * pelo logo da barra de abas é ação deliberada do usuário e vale mesmo com a
 * flag desligada.
 */
export const useSplash = create<SplashState>((set) => ({
  visible: SHOW_SPLASH,
  run: 0,
  close: () => set({ visible: false }),
  replay: () => set((st) => ({ visible: true, run: st.run + 1 })),
}));
