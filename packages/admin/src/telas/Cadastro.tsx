import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { fmtDia } from '../formato';
import { Confirmar, Estado, Marca, useAcao, useDados } from '../ui';

/**
 * Quem pode pedir conta, e quem já entra aprovado.
 *
 * É o que morava em `SIGNUP_OPEN` e `SIGNUP_ALLOWLIST`, no ConfigMap: aqui a
 * mudança vale no pedido seguinte, sem deploy nem restart.
 */
export function Cadastro() {
  const config = useDados(() => api.config(), []);
  const convites = useDados(() => api.convites(), []);
  const acao = useAcao();

  const [email, setEmail] = useState('');
  const [podeEnviar, setPodeEnviar] = useState(false);
  const [recebeDoBot, setRecebeDoBot] = useState(false);
  const [nota, setNota] = useState('');

  const convidar = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await acao.rodar(() => api.convidar({ email, podeEnviar, recebeDoBot, nota }));
    if (!ok) return;
    setEmail('');
    setNota('');
    setPodeEnviar(false);
    setRecebeDoBot(false);
    void convites.recarregar();
  };

  const aberto = config.dados?.cadastroAberto ?? false;

  return (
    <section>
      <h1>cadastro</h1>
      {acao.falha && (
        <p className="erro" role="alert">
          {acao.falha}
        </p>
      )}

      <Estado carregando={config.carregando} erro={config.erro} tem={!!config.dados}>
        <div className="painel">
          <div className="linha">
            <span className="rotulo">pedidos</span>
            <Marca
              ligado={aberto}
              rotulo="cadastro aberto"
              desabilitado={acao.ocupado}
              aoMudar={(v) =>
                void acao.rodar(() => api.definirCadastro(v)).then(() => config.recarregar())
              }
            />
            <span className={aberto ? 'ok' : 'mudo'}>
              {aberto
                ? 'aberto: qualquer pessoa pode pedir conta, e o pedido espera a sua análise'
                : 'fechado: só entra quem tem convite'}
            </span>
          </div>
        </div>
      </Estado>

      <h2>convites</h2>
      <p className="mudo">
        o e-mail convidado nasce aprovado ao se cadastrar, com o que você marcar aqui — e o convite
        some da lista quando é usado.
      </p>
      <form className="painel" onSubmit={(e) => void convidar(e)}>
        <div className="linha">
          <span className="rotulo">e-mail</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-label="E-mail a convidar"
            placeholder="pessoa@exemplo.com"
            autoComplete="off"
            required
            size={28}
          />
        </div>
        <div className="linha">
          <span className="rotulo">nasce com</span>
          <Marca ligado={podeEnviar} rotulo="convite: pode enviar" aoMudar={setPodeEnviar} />
          <span className="mudo">pode enviar</span>
          <Marca ligado={recebeDoBot} rotulo="convite: recebe do bot" aoMudar={setRecebeDoBot} />
          <span className="mudo">recebe do bot</span>
        </div>
        <div className="linha">
          <span className="rotulo">nota</span>
          <input
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            aria-label="Nota do convite"
            placeholder="opcional — de onde vem a pessoa"
            maxLength={200}
            size={36}
          />
          <button type="submit" className="primario" disabled={acao.ocupado || !email.trim()}>
            [convidar]
          </button>
        </div>
      </form>

      <Estado
        carregando={convites.carregando}
        erro={convites.erro}
        tem={!!convites.dados}
        vazio={convites.dados?.length === 0 && 'nenhum convite esperando.'}
      >
        <div className="rolagem">
          <table>
            <thead>
              <tr>
                <th>e-mail</th>
                <th>envia</th>
                <th>bot</th>
                <th>nota</th>
                <th>desde</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {convites.dados?.map((c) => (
                <tr key={c.email}>
                  <td>{c.email}</td>
                  <td className={c.podeEnviar ? 'ok' : 'mudo'}>{c.podeEnviar ? '[x]' : '[ ]'}</td>
                  <td className={c.recebeDoBot ? 'ok' : 'mudo'}>{c.recebeDoBot ? '[x]' : '[ ]'}</td>
                  <td className="mudo">{c.nota || '—'}</td>
                  <td className="mudo">{fmtDia(c.criadoEm)}</td>
                  <td className="acoes">
                    <Confirmar
                      rotulo="[remover]"
                      pergunta="remover o convite?"
                      desabilitado={acao.ocupado}
                      aoConfirmar={() =>
                        void acao
                          .rodar(() => api.removerConvite(c.email))
                          .then(() => convites.recarregar())
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Estado>
    </section>
  );
}
