import { gateCopy, type Gate as GateModel } from '@ondas/core';
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
        aria-label="permissão negada"
        onClick={(e) => e.stopPropagation()}
      >
        <span className={s.gateLabel}>permissão negada</span>
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
            {wide ? '[enter] entrar' : 'entrar'}
          </button>
          <button type="button" className={s.secondary} onClick={close}>
            {wide ? '[esc] agora não' : 'agora não'}
          </button>
        </div>
      </div>
    </div>
  );
}
