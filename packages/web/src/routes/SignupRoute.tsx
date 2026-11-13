import { AuthError, SENHA_MINIMA, t, tErro, type Params } from '@ondas/core';
import { useState, type InputHTMLAttributes } from 'react';
import { useNavigate } from 'react-router-dom';
import { saida } from '../app/controller';
import { auth } from '../app/services';
import { AuthShell } from './AuthShell';
import { assumirSessao } from './entrar';
import s from './login.module.css';
import { PATHS } from './paths';

/**
 * O pedido de conta.
 *
 * Não é um cadastro que entra: o pedido fica em análise até o admin aprovar, e
 * a tela termina dizendo isso — e dizendo COMO a pessoa vai ficar sabendo, que
 * é tentando entrar (a plataforma não manda e-mail). Sem essa frase o pedido
 * parece ter caído no vazio.
 *
 * A exceção é o e-mail que o admin já tinha liberado de antemão: aí o servidor
 * devolve a sessão junto, e a tela segue como um login.
 */
export function SignupRoute() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mensagem, setMensagem] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recebido, setRecebido] = useState(false);

  const voltar = () => navigate(PATHS.login);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Pela mesma razão do login: um `[sair]` ainda em curso mataria a sessão
      // que um pedido já aprovado abre.
      await saida();
      const resultado = await auth.signup({ name, email, password, mensagem });
      setPassword('');
      if (resultado.status === 'aprovada') {
        await assumirSessao(resultado.user, navigate);
        return;
      }
      setRecebido(true);
    } catch (err) {
      setError(
        err instanceof AuthError
          ? (tErro(err.codigo, err.params as Params | undefined) ?? err.message)
          : t('semRede.pedidoNaoEnviado'),
      );
    } finally {
      setBusy(false);
    }
  };

  // Um campo como os do login: linha de prompt, e `enter` envia de qualquer um.
  const campo = (
    rotulo: string,
    valor: string,
    mudar: (v: string) => void,
    props: InputHTMLAttributes<HTMLInputElement>,
  ) => (
    <label className={s.field}>
      <span className={s.fieldLabel}>{rotulo}</span>
      <input
        className={s.input}
        value={valor}
        onChange={(e) => {
          mudar(e.target.value);
          setError('');
        }}
        onKeyDown={(e) => e.key === 'Enter' && void submit()}
        {...props}
      />
    </label>
  );

  if (recebido) {
    return (
      <AuthShell titulo={t('cadastro.janela')} aoTeclar={(tecla) => tecla === 'Enter' && voltar()}>
        <div className={s.intro} role="status">
          <span className={s.aviso}>{t('cadastro.recebido')}</span>
          <br />
          {t('cadastro.recebidoLinha2')}
        </div>
        <div className={s.buttons}>
          <button type="button" className={s.primary} autoFocus onClick={voltar}>
            <span className={s.key}>[enter]</span>
            {t('cadastro.voltar')}
          </button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell titulo={t('cadastro.janela')} aoTeclar={(tecla) => tecla === 'Escape' && voltar()}>
      <div className={s.intro}>
        {t('cadastro.intro')}
        <br />
        {t('cadastro.introLinha2')}
      </div>

      <div className={s.fields}>
        {campo('name:', name, setName, {
          type: 'text',
          autoComplete: 'nickname',
          maxLength: 40,
          placeholder: t('cadastro.nomePlaceholder'),
        })}
        {campo('login:', email, setEmail, {
          type: 'email',
          inputMode: 'email',
          autoComplete: 'email',
          placeholder: 'voce@email.com',
        })}
        {campo('password:', password, setPassword, {
          type: 'password',
          autoComplete: 'new-password',
          placeholder: t('cadastro.senhaPlaceholder', { minimo: SENHA_MINIMA }),
        })}
        {campo('note:', mensagem, setMensagem, {
          type: 'text',
          autoComplete: 'off',
          maxLength: 500,
          placeholder: t('cadastro.mensagemPlaceholder'),
        })}
        {error && (
          <div className={s.error}>
            {t('ui.erro')} {error}
          </div>
        )}
      </div>

      <div className={s.buttons}>
        <button type="button" className={s.primary} disabled={busy} onClick={() => void submit()}>
          <span className={s.key}>[enter]</span>
          {t('cadastro.enviar')}
        </button>
        <button type="button" className={s.secondary} onClick={voltar}>
          <span className={s.key}>[esc]</span>
          {t('cadastro.voltar')}
        </button>
      </div>
    </AuthShell>
  );
}
