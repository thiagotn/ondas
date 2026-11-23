import { useState, type FormEvent } from 'react';
import { api, type Plano } from '../api';
import { escreverTamanho, fmtBytes, lerTamanho } from '../formato';
import { Estado, Marca, useAcao, useDados } from '../ui';

/**
 * Planos: quanto de armazenamento uma conta tem.
 *
 * Não há cobrança aqui. O plano responde só "qual é a cota"; a conta soma a ele
 * o extra avulso. Mudar a cota de um plano vale na hora para todas as contas
 * dele — e, nesta versão, a cota só é medida e mostrada: nada é recusado.
 */
export function Planos() {
  const { dados, erro, carregando, recarregar } = useDados(() => api.planos(), []);
  const config = useDados(() => api.config(), []);
  const acao = useAcao();
  const bloqueia = config.dados?.cotaBloqueia ?? false;
  const [id, setId] = useState('');
  const [nome, setNome] = useState('');
  const [cota, setCota] = useState('');
  const cotaLida = lerTamanho(cota);

  const criar = async (e: FormEvent) => {
    e.preventDefault();
    if (cotaLida === null) return;
    const ok = await acao.rodar(() => api.criarPlano({ id, nome, cotaBytes: cotaLida }));
    if (!ok) return;
    setId('');
    setNome('');
    setCota('');
    void recarregar();
  };

  return (
    <section>
      <h1>planos</h1>
      <p className="mudo">cota da conta = cota do plano + extra avulso da conta.</p>
      {acao.falha && (
        <p className="erro" role="alert">
          {acao.falha}
        </p>
      )}
      <Estado carregando={config.carregando} erro={config.erro} tem={!!config.dados}>
        <div className="painel">
          <div className="linha">
            <span className="rotulo">limite</span>
            <Marca
              ligado={bloqueia}
              rotulo="a cota bloqueia envio"
              desabilitado={acao.ocupado}
              aoMudar={(v) =>
                void acao.rodar(() => api.definirCotaBloqueia(v)).then(() => config.recarregar())
              }
            />
            <span className={bloqueia ? 'aviso' : 'mudo'}>
              {bloqueia
                ? 'bloqueia: conta acima da cota não recebe faixa nova (arquivo, link ou bot). nada é apagado'
                : 'só mede: a cota aparece nas telas, e nada é recusado'}
            </span>
          </div>
        </div>
      </Estado>
      <Estado carregando={carregando} erro={erro} tem={!!dados}>
        <div className="rolagem">
          <table>
            <thead>
              <tr>
                <th>id</th>
                <th>nome</th>
                <th>cota</th>
                <th className="num">contas</th>
              </tr>
            </thead>
            <tbody>
              {dados?.map((p) => (
                <LinhaDoPlano
                  key={p.id}
                  plano={p}
                  ocupado={acao.ocupado}
                  aoSalvar={(mudanca) =>
                    void acao.rodar(() => api.atualizarPlano(p.id, mudanca)).then(() => recarregar())
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      </Estado>

      <h2>novo plano</h2>
      <form className="painel" onSubmit={(e) => void criar(e)}>
        <div className="linha">
          <span className="rotulo">id</span>
          <input
            value={id}
            onChange={(e) => setId(e.target.value.toLowerCase())}
            aria-label="Id do plano"
            placeholder="ex.: plus"
            pattern="[a-z0-9-]{1,32}"
            required
            size={14}
          />
          <span className="mudo">minúsculas, números e hífen — não muda depois</span>
        </div>
        <div className="linha">
          <span className="rotulo">nome</span>
          <input
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            aria-label="Nome do plano"
            placeholder="ex.: Plus"
            maxLength={40}
            required
            size={20}
          />
        </div>
        <div className="linha">
          <span className="rotulo">cota</span>
          <input
            value={cota}
            onChange={(e) => setCota(e.target.value)}
            aria-label="Cota do plano"
            placeholder="ex.: 5 GB"
            required
            size={12}
          />
          <button
            type="submit"
            className="primario"
            disabled={acao.ocupado || !id || !nome.trim() || cotaLida === null}
          >
            [criar]
          </button>
          {cota && cotaLida === null && <span className="erro">não entendi o tamanho</span>}
        </div>
      </form>
    </section>
  );
}

function LinhaDoPlano({
  plano,
  ocupado,
  aoSalvar,
}: {
  plano: Plano;
  ocupado: boolean;
  aoSalvar: (mudanca: { nome?: string; cotaBytes?: number }) => void;
}) {
  const [nome, setNome] = useState(plano.nome);
  const [cota, setCota] = useState(escreverTamanho(plano.cotaBytes));
  const cotaLida = lerTamanho(cota);
  const mudou = nome.trim() !== plano.nome || (cotaLida !== null && cotaLida !== plano.cotaBytes);

  return (
    <tr>
      <td className="mudo">{plano.id}</td>
      <td>
        <input
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          aria-label={`Nome do plano ${plano.id}`}
          maxLength={40}
          size={16}
        />
      </td>
      <td>
        <input
          value={cota}
          onChange={(e) => setCota(e.target.value)}
          aria-label={`Cota do plano ${plano.id}`}
          size={10}
        />{' '}
        <button
          type="button"
          className="link"
          disabled={ocupado || !mudou || cotaLida === null || !nome.trim()}
          onClick={() =>
            aoSalvar({
              ...(nome.trim() !== plano.nome ? { nome: nome.trim() } : {}),
              ...(cotaLida !== null && cotaLida !== plano.cotaBytes ? { cotaBytes: cotaLida } : {}),
            })
          }
        >
          [salvar]
        </button>{' '}
        <span className={cotaLida === null ? 'erro' : 'mudo'}>
          {cotaLida === null ? 'não entendi' : fmtBytes(cotaLida)}
        </span>
      </td>
      <td className="num">{plano.contas}</td>
    </tr>
  );
}
