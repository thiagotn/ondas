import {
  AuthError,
  BANDEIRAS,
  idioma,
  LOCALES,
  t,
  tErro,
  themeIndex,
  type Params,
} from '@ondas/core';
import { Palette } from '@phosphor-icons/react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGuestMode } from '../app/guest';
import * as historico from '../app/historico';
import { CassetteLogo } from '../components/CassetteLogo';
import { sincronizar } from '../app/likes';
import { carregarPlaylists } from '../app/playlists';
import { auth } from '../app/services';
import { sessionStore, uiStore, useUi } from '../app/stores';
import { TrafficLights } from '../components/TrafficLights';
import s from './login.module.css';
import { PATHS } from './paths';

/**
 * Login. As credenciais são validadas pelo `AuthService` de `core` — hoje a
 * implementação local do protótipo, amanhã OAuth/JWT, sem mudar esta tela.
 */
export function LoginRoute() {
  const navigate = useNavigate();
  const themeId = useUi((st) => st.themeId);
  const enterAsGuest = useGuestMode((st) => st.enterAsGuest);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const user = await auth.login({ email, password });
      sessionStore.getState().setUser(user);
      // Traz as curtidas da conta — e sobe as que este aparelho guardava de
      // antes de elas serem da conta (`app/likes.ts`).
      void sincronizar();
      // E as playlists, pela mesma razão: elas são da conta, e o espelho deste
      // navegador acabou de ficar velho.
      void carregarPlaylists();
      // E o ponto onde a conta parou, que vira a faixa pausada no player.
      void historico.iniciar({ novaSessao: true });
      setPassword('');
      uiStore.getState().closeGate();
      uiStore.getState().flash(t('login.autenticado', { nome: user.name }));
      navigate(PATHS.home);
    } catch (err) {
      setError(
        err instanceof AuthError
          ? (tErro(err.codigo, err.params as Params | undefined) ?? err.message)
          : t('erro.falha_entrar'),
      );
    } finally {
      setBusy(false);
    }
  };

  const guest = () => {
    enterAsGuest();
    navigate(PATHS.home);
  };

  return (
    <div
      className={s.screen}
      onKeyDown={(e) => {
        // `g` entra como visitante e `t` abre os temas, mas não enquanto se digita.
        const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
        if (typing) return;
        if (e.key === 'g') guest();
        if (e.key === 't') uiStore.getState().openPicker(themeIndex(themeId));
        // O idioma precisa ser alcançável AQUI: é a primeira tela de quem não
        // fala português, e o `useShortcuts` (onde mora o `8`) só existe
        // dentro do `AppLayout`.
        if (e.key === '8') {
          uiStore.getState().setPickIdx(Math.max(0, LOCALES.indexOf(idioma())));
          uiStore.getState().abrirIdiomas();
        }
      }}
    >
      <div className={s.topbar}>
        <TrafficLights />
        <span className={s.topbarTitle}>{t('login.janela')}</span>
        <button
          type="button"
          className={s.palette}
          aria-label={t('barra.trocarIdioma')}
          title={t('barra.idioma')}
          onClick={() => {
            uiStore.getState().setPickIdx(Math.max(0, LOCALES.indexOf(idioma())));
            uiStore.getState().abrirIdiomas();
          }}
        >
          <span className={s.bandeira} aria-hidden="true">
            {BANDEIRAS[idioma()]}
          </span>
          {idioma()}
        </button>
        <button
          type="button"
          className={s.palette}
          aria-label={t('barra.trocarTema')}
          onClick={() => uiStore.getState().openPicker(themeIndex(themeId))}
        >
          <Palette size={15} />
          {themeId}
        </button>
      </div>

      <div className={s.content}>
        <div className={s.lockup}>
          <div className={s.lockupMark}>
            {/* Gira sozinho na abertura da tela, devagar: é vitrine, não player. */}
            <CassetteLogo playing progress={0.3} speed={3} ariaLabel="ondas" />
          </div>
          <div className={s.lockupText}>
            <span className={s.lockupName}>ondas</span>
            <span className={s.lockupSide}>{t('login.ladoA')}</span>
          </div>
        </div>
        <div className={s.intro}>
          {t('login.intro', { versao: __APP_VERSION__ })}
          <br />
          {t('login.introLinha2')}
        </div>

        <div className={s.fields}>
          <label className={s.field}>
            <span className={s.fieldLabel}>login:</span>
            <input
              className={s.input}
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="voce@email.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError('');
              }}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
            />
          </label>
          <label className={s.field}>
            <span className={s.fieldLabel}>password:</span>
            <input
              className={s.input}
              type="password"
              autoComplete="current-password"
              placeholder="••••"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError('');
              }}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
            />
          </label>
          {error && (
            <div className={s.error}>
              {t('ui.erro')} {error}
            </div>
          )}
        </div>

        <div className={s.buttons}>
          <button type="button" className={s.primary} onClick={() => void submit()}>
            <span className={s.key}>[enter]</span>
            {t('login.entrarCompleto')}
          </button>
          <button type="button" className={s.secondary} onClick={guest}>
            <span className={s.key}>[g]</span>
            {t('login.visitante')}
          </button>
        </div>
      </div>
    </div>
  );
}
