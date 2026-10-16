import { AuthError, themeIndex } from '@ondas/core';
import { Palette } from '@phosphor-icons/react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGuestMode } from '../app/guest';
import { auth } from '../app/services';
import { sessionStore, uiStore, useUi } from '../app/stores';
import { TrafficLights } from '../components/TabBar';
import s from './login.module.css';

const LOGO = ['┌─┐┌┐┌┌┬┐┌─┐┌─┐', '│ ││││ ││├─┤└─┐', '└─┘┘└┘─┴┘┴ ┴└─┘'].join('\n');

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
      setPassword('');
      uiStore.getState().closeGate();
      uiStore.getState().flash(`autenticado como ${user.name} — catálogo completo liberado`);
      navigate('/');
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'não foi possível entrar');
    } finally {
      setBusy(false);
    }
  };

  const guest = () => {
    enterAsGuest();
    navigate('/');
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
      }}
    >
      <div className={s.topbar}>
        <TrafficLights />
        <span className={s.topbarTitle}>ondas — login</span>
        <button
          type="button"
          className={s.palette}
          aria-label="Trocar tema"
          onClick={() => uiStore.getState().openPicker(themeIndex(themeId))}
        >
          <Palette size={15} />
          {themeId}
        </button>
      </div>

      <div className={s.content}>
        <pre className={s.logo} aria-label="ondas">
          {LOGO}
        </pre>
        <div className={s.intro}>
          ondas v1.0.0 — streaming de música independente
          <br />
          digite suas credenciais ou continue como visitante.
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
          {error && <div className={s.error}>error: {error}</div>}
        </div>

        <div className={s.buttons}>
          <button type="button" className={s.primary} onClick={() => void submit()}>
            <span className={s.key}>[enter]</span>
            entrar — catálogo completo + offline
          </button>
          <button type="button" className={s.secondary} onClick={guest}>
            <span className={s.key}>[g]</span>
            continuar como visitante — só faixas grátis
          </button>
        </div>
      </div>
    </div>
  );
}
