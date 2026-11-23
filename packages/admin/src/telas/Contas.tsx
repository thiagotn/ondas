import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type Conta } from '../api';
import { fmtDia, fmtHa, rotuloStatus } from '../formato';
import { Confirmar, Estado, Marca, Segmentos, Uso, useAcao, useDados } from '../ui';

const FILTROS = [
  { valor: '', rotulo: 'todas' },
  { valor: 'pendente', rotulo: 'em análise' },
  { valor: 'aprovada', rotulo: 'aprovadas' },
  { valor: 'negada', rotulo: 'negadas' },
] as const;

type Filtro = (typeof FILTROS)[number]['valor'];

/** O mais recente dos dois rastros de atividade que a conta tem. */
export function ultimaAtividade(c: Conta): string | undefined {
  const datas = [c.ultimoLoginEm, c.ultimaEscutaEm].filter((d): d is string => !!d);
  return datas.sort().at(-1);
}

export function Contas() {
  const [params, setParams] = useSearchParams();
  const navegar = useNavigate();
  const bruto = params.get('status') ?? '';
  const filtro: Filtro = FILTROS.some((f) => f.valor === bruto) ? (bruto as Filtro) : '';
  const { dados, erro, carregando, recarregar } = useDados(
    () => api.contas(filtro || undefined),
    [filtro],
  );
  const acao = useAcao();

  const fazer = (fn: () => Promise<unknown>) => void acao.rodar(fn).then(() => recarregar());

  return (
    <section>
      <h1>contas</h1>
      <Segmentos
        rotulo="Filtrar por status"
        opcoes={FILTROS}
        valor={filtro}
        aoMudar={(v) => setParams(v ? { status: v } : {})}
      />
      {acao.falha && (
        <p className="erro" role="alert">
          {acao.falha}
        </p>
      )}
      <Estado
        carregando={carregando}
        erro={erro}
        tem={!!dados}
        vazio={dados?.length === 0 && 'nenhuma conta neste recorte.'}
      >
        <div className="rolagem">
          <table>
            <thead>
              <tr>
                <th>conta</th>
                <th>status</th>
                <th title="pode enviar arquivo e pedir ingestão">envia</th>
                <th title="o bot pode publicar faixa para esta conta">bot</th>
                <th className="num">faixas</th>
                <th>ocupação</th>
                <th>atividade</th>
                <th>desde</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {dados?.map((c) => (
                <tr key={c.id} className="clicavel" onClick={() => navegar(`/contas/${c.id}`)}>
                  <td>
                    <Link to={`/contas/${c.id}`} onClick={(e) => e.stopPropagation()}>
                      {c.email}
                    </Link>
                    <div className="mudo">{c.name}</div>
                    {/* Texto de quem pediu a conta: dado não confiável, sempre
                        como texto. */}
                    {c.status === 'pendente' && c.mensagem && (
                      <div className="citacao">“{c.mensagem}”</div>
                    )}
                  </td>
                  <td className={`status-${c.status}`}>{rotuloStatus(c.status)}</td>
                  <td>
                    <Marca
                      ligado={c.podeEnviar}
                      rotulo={`${c.email} pode enviar`}
                      desabilitado={acao.ocupado}
                      aoMudar={(v) => fazer(() => api.ajustar(c.id, { podeEnviar: v }))}
                    />
                  </td>
                  <td>
                    <Marca
                      ligado={c.recebeDoBot}
                      rotulo={`${c.email} recebe do bot`}
                      desabilitado={acao.ocupado}
                      aoMudar={(v) => fazer(() => api.ajustar(c.id, { recebeDoBot: v }))}
                    />
                  </td>
                  <td className="num">{c.faixas}</td>
                  <td>
                    <Uso usado={c.usadoBytes} cota={c.cotaBytes} />
                  </td>
                  <td className="mudo">{fmtHa(ultimaAtividade(c))}</td>
                  <td className="mudo">{fmtDia(c.criadaEm)}</td>
                  <td className="acoes">
                    {c.status !== 'aprovada' && (
                      <button
                        type="button"
                        className="primario"
                        disabled={acao.ocupado}
                        onClick={(e) => {
                          e.stopPropagation();
                          fazer(() => api.aprovar(c.id));
                        }}
                      >
                        [aprovar]
                      </button>
                    )}
                    {c.status === 'pendente' && (
                      <button
                        type="button"
                        className="perigo"
                        disabled={acao.ocupado}
                        onClick={(e) => {
                          e.stopPropagation();
                          fazer(() => api.negar(c.id));
                        }}
                      >
                        [negar]
                      </button>
                    )}
                    {c.status === 'aprovada' && (
                      <Confirmar
                        rotulo="[suspender]"
                        pergunta="a conta para de entrar agora. suspender?"
                        desabilitado={acao.ocupado}
                        aoConfirmar={() => fazer(() => api.negar(c.id))}
                      />
                    )}
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
