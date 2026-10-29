import { parseComando } from '@ondas/core';
import * as controller from '../app/controller';
import { uiStore } from '../app/stores';
import { GENRE_PARAM } from '../routes/paths';
import { useQueryParam } from './useQueryParam';
import { useTabNavigation } from './useTabNavigation';

/**
 * Confirma a linha de comando: `:08` marca a faixa 08 e rola até ela.
 *
 * Vive aqui, e não no controller, porque precisa de `goToTab` e do gênero
 * ativo: o número é posição no catálogo INTEIRO, e em `--curtidas` ou na busca
 * a faixa 08 pode não estar no recorte da tela. Então, quando ela não estaria
 * visível, o comando leva para `~/em-alta` — a lista onde os números são
 * contíguos. O chip de gênero só é zerado quando é ele que esconde a faixa.
 */
export function useComando() {
  const { tab, goToTab } = useTabNavigation();
  const [genre] = useQueryParam(GENRE_PARAM, 'tudo', 'push');

  return (texto: string): void => {
    const cmd = parseComando(texto);
    const ui = uiStore.getState();
    ui.setCmdOpen(false);
    if (!cmd) return;
    const track = controller.irParaFaixa(cmd.numero);
    if (!track) return;

    const naTela = tab === 'home' && (genre === 'tudo' || track.genre === genre);
    if (naTela) return;
    // `goToTab` vai para o path limpo da aba, o que já zera o chip de gênero.
    goToTab('home');
  };
}
