import { THEMES, themeIndex } from '@ondas/core';
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import * as controller from '../app/controller';
import { libraryStore, playerStore, uiStore } from '../app/stores';
import { PATHS } from '../routes/paths';
import { applyTheme } from '../theme/applyTheme';
import { cmdInputRef } from './cmdInputRef';
import { useAboutOverlay } from './useAboutOverlay';
import { useAccountOverlay } from './useAccountOverlay';
import { useHelpOverlay } from './useHelpOverlay';
import { usePlayerOverlay } from './usePlayerOverlay';
import { useTabNavigation } from './useTabNavigation';

/**
 * Atalhos globais, com os mesmos bindings do handoff. Ignorados enquanto o foco
 * está num input — exceto Esc, que sai do campo e fecha overlays.
 *
 * A lista que a pessoa lê — na janela `ondas --help` e na legenda do rodapé —
 * vem de `shortcuts.ts`, no core. Tecla nova aqui pede linha nova lá.
 */
export function useShortcuts(searchInput: React.RefObject<HTMLInputElement>): void {
  const navigate = useNavigate();
  // A playlist aberta sai do ENDEREÇO, não de um estado de tela: é ele que diz
  // se `J`/`K` têm uma ordem para mexer (ver `playlistPath`).
  const { pathname } = useLocation();
  const { goToTab } = useTabNavigation();
  const { openPlayer, closePlayer, isPlayerOpen } = usePlayerOverlay();
  const { isAccountOpen, openAccount, closeAccount } = useAccountOverlay();
  const { isHelpOpen, openHelp, closeHelp } = useHelpOverlay();
  const { isAboutOpen, openAbout, closeAbout } = useAboutOverlay();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = uiStore.getState();
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
      const k = e.key;

      // O seletor de playlist captura o teclado, como o de tema — e antes
      // dele, porque é o mais recente a abrir quando os dois estão de pé.
      //
      // Sem `enter` aqui: a escolha é um ato irreversível de graça (adicionar
      // duas vezes não duplica), mas `enter` sem linha é um clique no vazio.
      if (ui.seletorPlaylist) {
        const quantas = libraryStore.getState().playlists.length;
        if (k === 'Escape') ui.fecharSeletorPlaylist();
        else if (quantas && (k === 'j' || k === 'ArrowDown' || k === 'k' || k === 'ArrowUp')) {
          e.preventDefault();
          const dir = k === 'j' || k === 'ArrowDown' ? 1 : -1;
          ui.setSeletorIdx((ui.seletorIdx + dir + quantas) % quantas);
        } else if (k === 'Enter' && quantas) {
          e.preventDefault();
          const alvo = libraryStore.getState().playlists[ui.seletorIdx];
          if (alvo) void controller.adicionarMarcadas(alvo.id);
        }
        return;
      }

      // Theme picker captura o teclado enquanto está aberto.
      if (ui.pickerOpen) {
        if (k === 'Escape' || k === 't' || k === '4') {
          applyTheme(ui.themeId, ui.opacity);
          ui.closePicker();
        } else if (k === 'j' || k === 'ArrowDown' || k === 'k' || k === 'ArrowUp') {
          e.preventDefault();
          const dir = k === 'j' || k === 'ArrowDown' ? 1 : -1;
          const next = (ui.pickIdx + dir + THEMES.length) % THEMES.length;
          ui.setPickIdx(next);
          applyTheme(THEMES[next]!.id, ui.opacity);
        } else if (k === 'Enter') {
          e.preventDefault();
          controller.setTheme(THEMES[ui.pickIdx]!.id);
        }
        return;
      }

      if (k === 'Escape') {
        if (typing) target?.blur();
        // Um Esc fecha UMA camada, a de cima: com conta aberta sobre o player,
        // fechar os dois de uma vez tiraria da tela algo que não se pediu. O
        // gate entrou na cadeia porque é ele que fica por cima de todos
        // (`AppLayout`), e fechá-lo incondicionalmente levava embora também a
        // camada de baixo — invisível enquanto o player era um param, visível
        // agora que fechá-lo é navegar.
        if (ui.gate) ui.closeGate();
        else if (isAboutOpen) closeAbout();
        else if (isHelpOpen) closeHelp();
        else if (isAccountOpen) closeAccount();
        else if (isPlayerOpen) closePlayer();
        // A seleção é o ÚLTIMO elo: ela não é overlay, está na própria lista, e
        // por isso é a camada de baixo. Sair dela limpa as marcas (ver
        // `sairDaSelecao`), que é o que o Esc significa aqui — desistir.
        else if (ui.selecionando) ui.sairDaSelecao();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      // Com o gate aberto, Enter leva para o login.
      if (ui.gate && k === 'Enter') {
        ui.closeGate();
        // Como no Gate: sair para o login já leva a rota da faixa embora.
        navigate(PATHS.login);
        return;
      }

      // Com um overlay por cima, a lista não está na tela: andar com um cursor
      // invisível deixaria o Enter tocando algo que ninguém viu.
      const naLista = !isPlayerOpen && !isAccountOpen && !isHelpOpen && !isAboutOpen;
      const janelaDeAtalhos = () => (isHelpOpen ? closeHelp() : openHelp());

      // Enter fica FORA do mapa de ações: lá o `preventDefault` é incondicional,
      // e num botão ou link focado ele cancelaria o clique do próprio elemento
      // — a tecla de ativar deixaria de ativar. Aqui só age quando é a lista
      // que está na tela e o foco não é de ninguém.
      if (k === 'Enter') {
        const tag = target?.tagName;
        if (!naLista || tag === 'BUTTON' || tag === 'A') return;
        e.preventDefault();
        controller.tocarCursor();
        return;
      }

      const actions: Record<string, () => void> = {
        ' ': () => controller.togglePlay(),
        n: () => controller.step(1),
        p: () => controller.step(-1),
        ArrowRight: () => controller.seekBy(10),
        ArrowLeft: () => controller.seekBy(-10),
        l: () => controller.likeCurrent(),
        c: () => controller.shareCurrent(),
        d: () => controller.downloadCurrent(),
        s: () => playerStore.getState().toggleShuffle(),
        r: () => playerStore.getState().toggleRepeat(),
        t: () => ui.openPicker(themeIndex(ui.themeId)),
        f: () => (isPlayerOpen ? closePlayer() : openPlayer()),
        j: () => naLista && controller.moverCursor(1),
        k: () => naLista && controller.moverCursor(-1),
        // `v` de visual, como no vim: liga a marcação e marca a linha do cursor
        // de uma vez, para a primeira tecla já ter feito algo.
        v: () => {
          if (!naLista) return;
          if (ui.selecionando) ui.sairDaSelecao();
          else controller.marcar(ui.cursorId ?? undefined);
        },
        x: () => naLista && controller.marcarCursorNaSelecao(),
        // `a` e não `enter`: `enter` é "tocar a linha marcada" e continua sendo
        // (ouvir antes de adicionar é o uso), e a janela `?` não pode listar a
        // mesma tecla duas vezes dizendo coisas diferentes.
        a: () => {
          if (!naLista || !controller.quantasMarcadas()) return;
          if (libraryStore.getState().playlists.length) ui.abrirSeletorPlaylist();
          // Sem playlist nenhuma o seletor seria um painel vazio; o caminho é o
          // botão `[+ playlist]`, que abre o campo de nome.
          else ui.flash('nenhuma playlist ainda — use [+ playlist] para criar a primeira');
        },
        // `J`/`K` só fazem sentido dentro de uma playlist, que é a única lista
        // com ordem própria para mexer.
        J: () => naLista && moverNaPlaylistDaRota(pathname, 1),
        K: () => naLista && moverNaPlaylistDaRota(pathname, -1),
        // `0` é "a de agora", os outros dígitos são lugares. Faz o mesmo que o
        // `f` do handoff, que fica valendo sem ser anunciado.
        '0': () => (isPlayerOpen ? closePlayer() : openPlayer()),
        '1': () => goToTab('home'),
        '2': () => goToTab('search'),
        '3': () => goToTab('library'),
        // Alternar, não só abrir: `show()` empilha histórico, e abrir o que já
        // está aberto deixaria um "voltar" que não volta nada.
        '4': () => ui.openPicker(themeIndex(ui.themeId)),
        '5': () => (isAccountOpen ? closeAccount() : openAccount()),
        '6': janelaDeAtalhos,
        '7': () => (isAboutOpen ? closeAbout() : openAbout()),
        '?': janelaDeAtalhos,
        '/': () => {
          // Sem `closePlayer`: a troca de aba já sai de `/t/...`, e fechar o
          // player por cima dela desfaria a navegação que acabou de acontecer.
          goToTab('search');
          setTimeout(() => searchInput.current?.focus(), 30);
        },
        // A linha de comando é um input de verdade, então o guarda `typing`
        // desliga todo o resto enquanto se digita — inclusive os dígitos, que
        // senão trocariam de aba no meio do `:12`.
        ':': () => {
          // Com o player aberto basta fechá-lo: a entrada que vai embora é a
          // que carregava os params dos outros dois overlays.
          if (isPlayerOpen) closePlayer();
          else {
            if (isHelpOpen) closeHelp();
            if (isAccountOpen) closeAccount();
            if (isAboutOpen) closeAbout();
          }
          ui.setCmdOpen(true);
          setTimeout(() => cmdInputRef.current?.focus(), 30);
        },
      };
      // A simulação de queda de rede só existe no build de dev.
      if (import.meta.env.DEV) actions['o'] = () => controller.toggleSimulatedOffline();

      const action = actions[k];
      if (action) {
        e.preventDefault();
        action();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    closeAbout,
    closeAccount,
    closeHelp,
    closePlayer,
    goToTab,
    isAboutOpen,
    isAccountOpen,
    isHelpOpen,
    isPlayerOpen,
    navigate,
    openAbout,
    openAccount,
    openHelp,
    openPlayer,
    pathname,
    searchInput,
  ]);
}

/**
 * O id da playlist aberta, lido do endereço.
 *
 * Daqui e não de um estado de tela: a rota é a dona de qual playlist está
 * aberta (`/library/playlists/<id>`), e um segundo dono divergiria dela — foi o
 * que já aconteceu entre a aba e o `playerOpen`.
 */
function moverNaPlaylistDaRota(pathname: string, dir: 1 | -1): void {
  const partes = pathname.split('/').filter(Boolean);
  if (partes[0] !== 'library' || partes[1] !== 'playlists' || !partes[2]) return;
  controller.moverNaPlaylist(partes[2], dir);
}
