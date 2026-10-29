import type { TabId } from '@ondas/core';
import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { TAB_PATHS, tabForPath } from '../routes/paths';

/** Rota ⇄ aba: a aba ativa é derivada da URL, nunca duplicada em estado. */
export function useTabNavigation() {
  const navigate = useNavigate();
  const { pathname, state } = useLocation();
  // Em `/t/...` o path é o da faixa, não o de uma aba: a aba vem de onde o
  // player foi aberto. Sem isto a TabBar marcaria `em-alta` para quem abriu o
  // player estando na biblioteca.
  const origem = (state as { from?: unknown } | null)?.from;
  const daOrigem = typeof origem === 'string' ? tabForPath(origem.split('?')[0]!) : undefined;
  const tab: TabId = tabForPath(pathname) ?? daOrigem ?? 'home';

  const goToTab = useCallback(
    (next: TabId) => {
      // O path limpo da aba, sem carregar a query da anterior: cada tela tem os
      // seus params (o gênero do em-alta, o termo da busca), e os overlays
      // ficariam colados na tela — antes `?atalhos=1` sobrevivia a um `1`.
      navigate(TAB_PATHS[next]);
    },
    [navigate],
  );

  return { tab, goToTab };
}
