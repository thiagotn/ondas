import { findLibrarySegment, librarySegmentChip, parseComando, t } from '@ondas/core';
import { useLocation, useNavigate } from 'react-router-dom';
import * as controller from '../app/controller';
import { sessionStore, uiStore } from '../app/stores';
import { GENRE_PARAM, librarySegPath } from '../routes/paths';
import { useQueryParam } from './useQueryParam';
import { useTabNavigation } from './useTabNavigation';

/**
 * Confirma a linha de comando: `:08` marca a faixa 08 e rola até ela, e
 * `:historico` abre esse recorte da biblioteca.
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
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (texto: string): void => {
    const cmd = parseComando(texto);
    const ui = uiStore.getState();
    ui.setCmdOpen(false);
    if (!cmd) return;

    if (cmd.kind === 'recorte') {
      // O nome vale de qualquer tela: é um endereço, e o `:` já fechou o que
      // estava por cima (ver `useShortcuts`). O que não leva a lugar nenhum
      // diz por quê em vez de falhar calado — ao contrário do número fora de
      // alcance, aqui a pessoa digitou uma palavra e espera uma resposta.
      const achado = findLibrarySegment(cmd.nome, sessionStore.getState().user);
      if (achado.ok) {
        const destino = librarySegPath(achado.seg);
        // Já está nele: empilhar o mesmo endereço deixaria um voltar que não
        // volta nada.
        if (pathname !== destino) navigate(destino);
        return;
      }
      if (achado.motivo === 'conta') {
        // Sem navegar: o chip não existe para quem não entrou, e a tela ficaria
        // num recorte sem nenhum marcado.
        ui.flash(t('toast.recorteSoComConta', { recorte: librarySegmentChip(achado.seg) }));
      } else if (achado.motivo === 'ambiguo') {
        ui.flash(
          t('toast.recorteAmbiguo', {
            nome: cmd.nome,
            opcoes: achado.opcoes.map((seg) => '--' + librarySegmentChip(seg)).join(', '),
          }),
        );
      } else {
        ui.flash(t('toast.recorteNaoExiste', { nome: cmd.nome }));
      }
      return;
    }

    const track = controller.irParaFaixa(cmd.numero);
    if (!track) return;

    const naTela = tab === 'home' && (genre === 'tudo' || track.genre === genre);
    if (naTela) return;
    // `goToTab` vai para o path limpo da aba, o que já zera o chip de gênero.
    goToTab('home');
  };
}
