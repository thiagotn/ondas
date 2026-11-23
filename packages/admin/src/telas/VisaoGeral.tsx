import { Link } from 'react-router-dom';
import { api } from '../api';
import { fmtBytes } from '../formato';
import { Estado, Uso, useDados } from '../ui';

/** A primeira tela: o tamanho de tudo, e o que está esperando por você. */
export function VisaoGeral() {
  const resumo = useDados(() => api.resumo(), []);
  const contas = useDados(() => api.contas(), []);
  const r = resumo.dados;

  // Quem mais ocupa. A lista de contas já traz o uso de cada uma, então a
  // ordenação é daqui — não vale uma rota só para isso.
  const maiores = [...(contas.dados ?? [])]
    .filter((c) => c.usadoBytes > 0)
    .sort((a, b) => b.usadoBytes - a.usadoBytes)
    .slice(0, 8);

  return (
    <section>
      <h1>visão geral</h1>
      <Estado carregando={resumo.carregando} erro={resumo.erro} tem={!!r}>
        {r && (
          <div className="cartoes">
            <Link className="cartao" to="/contas?status=pendente">
              <span className="rotulo">pedidos em análise</span>
              <span className={r.contas['pendente'] ? 'numero aviso' : 'numero'}>
                {r.contas['pendente'] ?? 0}
              </span>
              <span className="mudo">
                {r.contas['aprovada'] ?? 0} aprovadas · {r.contas['negada'] ?? 0} negadas
              </span>
            </Link>
            <Link className="cartao" to="/faixas">
              <span className="rotulo">armazenamento</span>
              <span className="numero">{fmtBytes(r.audioBytes + r.capaBytes)}</span>
              <span className="mudo">
                {r.faixas} faixas · {fmtBytes(r.audioBytes)} de áudio · {fmtBytes(r.capaBytes)} de
                capas
              </span>
            </Link>
            <Link className="cartao" to="/ingestoes?status=error">
              <span className="rotulo">ingestões</span>
              <span className={r.ingestoes['error'] ? 'numero erro' : 'numero'}>
                {r.ingestoes['error'] ?? 0} com erro
              </span>
              <span className="mudo">
                {(r.ingestoes['pending'] ?? 0) + (r.ingestoes['processing'] ?? 0)} na fila ·{' '}
                {r.ingestoes['ready'] ?? 0} prontas
              </span>
            </Link>
            <Link className="cartao" to="/cadastro">
              <span className="rotulo">cadastro</span>
              <span className={r.cadastroAberto ? 'numero ok' : 'numero'}>
                {r.cadastroAberto ? 'aberto' : 'fechado'}
              </span>
              <span className="mudo">{r.convites} convite(s) esperando</span>
            </Link>
            <Link className="cartao" to="/contas">
              <span className="rotulo">acima da cota</span>
              <span className={r.acimaDaCota ? 'numero aviso' : 'numero'}>{r.acimaDaCota}</span>
              <span className="mudo">a cota hoje só é medida — nada é recusado</span>
            </Link>
          </div>
        )}
      </Estado>

      <h2>quem mais ocupa</h2>
      <Estado
        carregando={contas.carregando}
        erro={contas.erro}
        tem={!!contas.dados}
        vazio={maiores.length === 0 && 'nenhuma conta tem faixa no acervo ainda.'}
      >
        <div className="rolagem">
          <table>
            <thead>
              <tr>
                <th>conta</th>
                <th className="num">faixas</th>
                <th>ocupação</th>
                <th>plano</th>
              </tr>
            </thead>
            <tbody>
              {maiores.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/contas/${c.id}`}>{c.email}</Link>
                  </td>
                  <td className="num">{c.faixas}</td>
                  <td>
                    <Uso usado={c.usadoBytes} cota={c.cotaBytes} />
                  </td>
                  <td className="mudo">{c.planoNome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Estado>
    </section>
  );
}
