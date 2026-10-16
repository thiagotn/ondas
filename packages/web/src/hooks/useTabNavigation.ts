import type { TabId } from '@ondas/core';
import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

export const TAB_PATHS: Record<TabId, string> = {
  home: '/',
  search: '/buscar',
  library: '/biblioteca',
};

const PATH_TABS: Record<string, TabId> = {
  '/': 'home',
  '/buscar': 'search',
  '/biblioteca': 'library',
};

/** Rota ⇄ aba: a aba ativa é derivada da URL, nunca duplicada em estado. */
export function useTabNavigation() {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const tab: TabId = PATH_TABS[pathname] ?? 'home';

  const goToTab = useCallback(
    (next: TabId) => {
      // Trocar de aba fecha o full player, mantendo o resto da query.
      const params = new URLSearchParams(search);
      params.delete('player');
      const qs = params.toString();
      navigate(TAB_PATHS[next] + (qs ? '?' + qs : ''));
    },
    [navigate, search],
  );

  return { tab, goToTab };
}
