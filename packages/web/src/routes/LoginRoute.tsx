import { AuthError, t, tErro, type Params } from '@ondas/core';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { saida } from '../app/controller';
import { useGuestMode } from '../app/guest';
import { auth } from '../app/services';
import { AuthShell } from './AuthShell';
import { assumirSessao } from './entrar';
import s from './login.module.css';
import { PATHS } from './paths';

/**
 * Login. As credenciais são validadas pelo `AuthService` de `core` — hoje a
 * implementação local do protótipo, amanhã OAuth/JWT, sem mudar esta tela.
 */
export function LoginRoute() {
  const navigate = useNavigate();
  const enterAsGuest = useGuestMode((st) => st.enterAsGuest);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Um `[sair]` de instantes atrás pode ainda estar correndo, e ele mataria
      // a sessão que este login vai abrir (ver `controller.saida`).
      await saida();
      const user = await auth.login({ email, password });
      setPassword('');
      await assumirSessao(user, navigate);
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
    <AuthShell
      titulo={t('login.janela')}
      aoTeclar={(tecla) => {
        // `g` entra como visitante e `c` leva ao pedido de conta.
        if (tecla === 'g') guest();
        if (tecla === 'c') navigate(PATHS.signup);
      }}
    >
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
        <button type="button" className={s.secondary} onClick={() => navigate(PATHS.signup)}>
          <span className={s.key}>[c]</span>
          {t('login.pedirConta')}
        </button>
      </div>
    </AuthShell>
  );
}
