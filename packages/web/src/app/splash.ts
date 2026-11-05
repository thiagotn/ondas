import { create } from 'zustand';
import { recarregouParaAtualizar } from './atualizacao';
import { SHOW_SPLASH } from './services';

interface SplashState {
  visible: boolean;
  close(): void;
}

/**
 * Abertura do app. A flag `SHOW_SPLASH` decide se ela aparece no boot, e esse é
 * o único momento em que ela roda: o botão `[rever abertura]` do `ondas --about`
 * saiu, e com ele o `replay()` e o contador `run` que reiniciava o cronômetro do
 * componente. A abertura é o que se vê ao chegar, uma vez.
 *
 * `recarregouParaAtualizar()` é a exceção: quando esta carga é a recarga que
 * troca de versão, a abertura NÃO roda. Para quem está usando o app é a mesma
 * sessão continuando, e vê-la duas vezes seguidas era exatamente o sintoma que
 * denunciou o reload automático.
 */
export const useSplash = create<SplashState>((set) => ({
  visible: SHOW_SPLASH && !recarregouParaAtualizar(),
  close: () => set({ visible: false }),
}));
