import { fmtMB, offlineBytes, planLabel, whoAmI } from '@ondas/core';
import { useNavigate } from 'react-router-dom';
import * as controller from '../app/controller';
import { libraryStore, useLibrary, useSession } from '../app/stores';
import { useGuestMode } from '../app/guest';
import s from './shell.module.css';

/** Painel `conta / buffer / offline` da biblioteca. */
export function LibraryPanel() {
  const navigate = useNavigate();
  const user = useSession((st) => st.user);
  const leaveGuest = useGuestMode((st) => st.leaveGuest);
  const prefetch = useLibrary((st) => st.prefetch);
  const cached = useLibrary((st) => st.cached);
  const sizes = useLibrary((st) => st.sizes);

  const count = Object.keys(cached).length;

  return (
    <div className={s.panel}>
      <div className={s.panelRow}>
        <span className={s.panelLabel}>conta</span>
        <span className={s.panelValue}>
          {whoAmI(user)} <span className={s.panelMuted}>· {planLabel(user)}</span>
        </span>
        {user ? (
          <button
            type="button"
            className={s.logout}
            onClick={() => {
              void controller.logout();
              leaveGuest();
              navigate('/login');
            }}
          >
            [sair]
          </button>
        ) : (
          <button type="button" className={s.link} onClick={() => navigate('/login')}>
            [entrar]
          </button>
        )}
      </div>

      <button
        type="button"
        className={`${s.panelRow} ${s.panelButton}`}
        aria-pressed={prefetch}
        onClick={() => libraryStore.getState().togglePrefetch()}
      >
        <span className={s.panelLabel}>buffer</span>
        <span className={prefetch ? s.checkOn : s.checkOff}>{prefetch ? '[x]' : '[ ]'}</span>
        <span className={s.panelValue}>pré-carregar a próxima faixa no aparelho</span>
      </button>

      <div className={s.panelRow}>
        <span className={s.panelLabel}>offline</span>
        <span className={s.panelValue}>
          {count} faixas · {fmtMB(offlineBytes({ cached, sizes }))}
        </span>
      </div>
    </div>
  );
}
