import { create } from 'zustand';
import { recarregouParaAtualizar } from './atualizacao';
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
 *
 * `recarregouParaAtualizar()` é a exceção: quando esta carga é a recarga que
 * troca de versão, a abertura NÃO roda. Para quem está usando o app é a mesma
 * sessão continuando, e vê-la duas vezes seguidas era exatamente o sintoma que
 * denunciou o reload automático.
 */
export const useSplash = create<SplashState>((set) => ({
  visible: SHOW_SPLASH && !recarregouParaAtualizar(),
  run: 0,
  close: () => set({ visible: false }),
  replay: () => set((st) => ({ visible: true, run: st.run + 1 })),
}));
