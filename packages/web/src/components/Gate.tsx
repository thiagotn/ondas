import { gateCopy, t, type Gate as GateModel } from '@ondas/core';
import { useNavigate } from 'react-router-dom';
import { uiStore } from '../app/stores';
import { useWide } from '../hooks/useWide';
import { PATHS } from '../routes/paths';
import s from './overlay.module.css';

/** "permissão negada": faixa [pro] para visitante, ou download sem conta. */
export function Gate({ gate }: { gate: GateModel }) {
  const navigate = useNavigate();
  const wide = useWide();
  const copy = gateCopy(gate);
  const close = () => uiStore.getState().closeGate();

  return (
    <div className={s.backdrop} onClick={close} role="presentation">
      <div
        className={s.gate}
        role="alertdialog"
        aria-modal="true"
        aria-label={t('gate.titulo')}
        onClick={(e) => e.stopPropagation()}
      >
        <span className={s.gateLabel}>{t('gate.titulo')}</span>
        <div>{copy.title}</div>
        <div className={s.gateBody}>{copy.body}</div>
        <div className={s.actions}>
          <button
            type="button"
            className={s.primary}
            autoFocus
            onClick={() => {
              close();
              // Ir para o login já sai da rota da faixa: o player fecha com ela.
              navigate(PATHS.login);
            }}
          >
            {t(wide ? 'gate.entrarEnter' : 'gate.entrar')}
          </button>
          <button type="button" className={s.secondary} onClick={close}>
            {t(wide ? 'gate.agoraNaoEsc' : 'gate.agoraNao')}
          </button>
        </div>
      </div>
    </div>
  );
}
