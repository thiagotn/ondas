import { useState, type FormEvent } from 'react';
import { api, ErroDaApi } from '../api';

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
      if (err instanceof ErroDaApi && err.status === 401) setErro('token inválido');
      else if (err instanceof ErroDaApi && err.status === 429)
        setErro('muitas tentativas — espere alguns minutos');
      else setErro(err instanceof Error ? err.message : 'não foi possível entrar');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <form className="entrada" onSubmit={(e) => void enviar(e)}>
      <h1>
        <span className="destaque">ondas</span> admin
      </h1>
      <p className="mudo">cole o token de admin. ele não fica guardado neste navegador.</p>
      <label className="campo">
        <span className="rotulo">token</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          aria-label="Token de admin"
        />
      </label>
      {erro && (
        <p className="erro" role="alert">
          {erro}
        </p>
      )}
      <button type="submit" className="primario" disabled={!token.trim() || ocupado}>
        {ocupado ? '⠋ entrando…' : '[entrar]'}
      </button>
    </form>
  );
}
