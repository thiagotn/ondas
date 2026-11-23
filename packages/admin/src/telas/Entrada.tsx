import { useState, type FormEvent } from 'react';
import { api, ErroDaApi } from '../api';
import { t } from '../i18n';
import { Preferencias } from '../ui';

/**
 * A entrada: o token de admin, uma vez.
 *
 * O campo é `type="password"` e `autocomplete="off"`: o token não é uma senha
 * de conta e não deve ir parar no gerenciador de senhas do navegador com o
 * rótulo errado. Ele fica só no estado deste formulário até o servidor
 * responder; o que sobra depois é o cookie, que script nenhum lê.
 */
export function Entrada({ aoEntrar }: { aoEntrar: () => void }) {
  const [token, setToken] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim() || ocupado) return;
    setOcupado(true);
    setErro(null);
    try {
      await api.entrar(token.trim());
      setToken('');
      aoEntrar();
    } catch (err) {
      if (err instanceof ErroDaApi && err.status === 401) setErro(t('entrada.tokenInvalido'));
      else if (err instanceof ErroDaApi && err.status === 429)
        setErro(t('entrada.muitasTentativas'));
      else setErro(err instanceof Error ? err.message : t('entrada.naoDeu'));
    } finally {
      setOcupado(false);
    }
  };

  return (
    <form className="entrada" onSubmit={(e) => void enviar(e)}>
      {/* Antes de entrar também: quem não lê português precisa trocar o idioma
          justamente aqui. */}
      <div className="entrada-prefs">
        <Preferencias />
      </div>
      <h1>
        <span className="destaque">ondas</span> admin
      </h1>
      <p className="mudo">{t('entrada.explica')}</p>
      <label className="campo">
        <span className="rotulo">{t('entrada.token')}</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          aria-label={t('entrada.tokenRotulo')}
        />
      </label>
      {erro && (
        <p className="erro" role="alert">
          {erro}
        </p>
      )}
      <button type="submit" className="primario" disabled={!token.trim() || ocupado}>
        {ocupado ? t('entrada.entrando') : t('entrada.entrar')}
      </button>
    </form>
  );
}
