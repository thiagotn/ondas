import { t } from '@ondas/core';
import { useNavigate } from 'react-router-dom';
import { PATHS } from '../routes/paths';
import s from './shell.module.css';

/** Aviso de sessão de visitante, com atalho para o login. */
export function GuestNotice() {
  const navigate = useNavigate();
  return (
    <div className={s.notice}>
      <span className={s.noticeLabel}>{t('ui.aviso')}</span>
      <span className={s.noticeText}>{t('visitante.aviso')}</span>
      <button type="button" className={s.link} onClick={() => navigate(PATHS.login)}>
        {t('ui.entrar')}
      </button>
    </div>
  );
}
