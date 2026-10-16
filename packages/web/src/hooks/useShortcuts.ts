import { THEMES, themeIndex } from '@ondas/core';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as controller from '../app/controller';
import { playerStore, uiStore } from '../app/stores';
import { applyTheme } from '../theme/applyTheme';
import { usePlayerOverlay } from './usePlayerOverlay';
import { useTabNavigation } from './useTabNavigation';

/**
 * Atalhos globais, com os mesmos bindings do handoff. Ignorados enquanto o foco
 * está num input — exceto Esc, que sai do campo e fecha overlays.
 */
export function useShortcuts(searchInput: React.RefObject<HTMLInputElement>): void {
  const navigate = useNavigate();
  const { goToTab } = useTabNavigation();
  const { openPlayer, closePlayer, isPlayerOpen } = usePlayerOverlay();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = uiStore.getState();
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
      const k = e.key;

      // Theme picker captura o teclado enquanto está aberto.
      if (ui.pickerOpen) {
        if (k === 'Escape') {
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
        if (isPlayerOpen) closePlayer();
        ui.closeGate();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      // Com o gate aberto, Enter leva para o login.
      if (ui.gate && k === 'Enter') {
        ui.closeGate();
        if (isPlayerOpen) closePlayer();
        navigate('/login');
        return;
      }

      const actions: Record<string, () => void> = {
        ' ': () => controller.togglePlay(),
        n: () => controller.step(1),
        p: () => controller.step(-1),
        ArrowRight: () => controller.seekBy(10),
        ArrowLeft: () => controller.seekBy(-10),
        l: () => controller.likeCurrent(),
        d: () => controller.downloadCurrent(),
        s: () => playerStore.getState().toggleShuffle(),
        r: () => playerStore.getState().toggleRepeat(),
        t: () => ui.openPicker(themeIndex(ui.themeId)),
        f: () => (isPlayerOpen ? closePlayer() : playerStore.getState().cur >= 0 && openPlayer()),
        '1': () => goToTab('home'),
        '2': () => goToTab('search'),
        '3': () => goToTab('library'),
        '/': () => {
          goToTab('search');
          if (isPlayerOpen) closePlayer();
          setTimeout(() => searchInput.current?.focus(), 30);
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
  }, [closePlayer, goToTab, isPlayerOpen, navigate, openPlayer, searchInput]);
}
