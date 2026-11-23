import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type Conta } from '../api';
import { fmtDia, fmtHa, rotuloStatus } from '../formato';
import { t } from '../i18n';
import { Busca, NadaCasa, ThOrd, useLista, type Config } from '../lista';
import { Confirmar, Estado, Marca, Segmentos, Uso, useAcao, useDados } from '../ui';

const FILTROS = [
  { valor: '', chave: 'contas.todas' },
  { valor: 'pendente', chave: 'contas.emAnalise' },
  { valor: 'aprovada', chave: 'contas.aprovadas' },
  { valor: 'negada', chave: 'contas.negadas' },
] as const;

type Filtro = (typeof FILTROS)[number]['valor'];

/** O mais recente dos dois rastros de atividade que a conta tem. */
export function ultimaAtividade(c: Conta): string | undefined {
  const datas = [c.ultimoLoginEm, c.ultimaEscutaEm].filter((d): d is string => !!d);
  return datas.sort().at(-1);
}

const LISTA: Config<Conta> = {
  colunas: {
    conta: (c) => c.email,
    status: (c) => c.status,
    envia: (c) => c.podeEnviar,
    bot: (c) => c.recebeDoBot,
    faixas: (c) => c.faixas,
    // Pelos bytes, não pela fração da cota: "quem ocupa mais" é a pergunta
    // desta coluna; quem estourou tem o cartão da visão geral.
    usado: (c) => c.usadoBytes,
    atividade: (c) => ultimaAtividade(c),
    desde: (c) => c.criadaEm,
  },
  // A mensagem do pedido entra na busca: é por ela que se reconhece quem pediu.
  texto: (c) => `${c.email} ${c.name} ${rotuloStatus(c.status)} ${c.planoNome} ${c.mensagem ?? ''}`,
  descPrimeiro: ['envia', 'bot', 'faixas', 'usado', 'atividade', 'desde'],
};

export function Contas() {
  const [params, setParams] = useSearchParams();
  const navegar = useNavigate();
  const bruto = params.get('status') ?? '';
  const filtro: Filtro = FILTROS.some((f) => f.valor === bruto) ? (bruto as Filtro) : '';
  const { dados, erro, carregando, recarregar } = useDados(
    () => api.contas(filtro || undefined),
    [filtro],
  );
  const lista = useLista(dados, LISTA);
  const acao = useAcao();

  const fazer = (fn: () => Promise<unknown>) => void acao.rodar(fn).then(() => recarregar());

  return (
    <section>
      <h1>{t('aba.contas')}</h1>
      <div className="filtros">
        <Segmentos
          rotulo={t('contas.filtroStatus')}
          opcoes={FILTROS.map((f) => ({ valor: f.valor, rotulo: t(f.chave) }))}
          valor={filtro}
          aoMudar={(v) =>
            // Só o status muda: a busca e a ordem continuam valendo no recorte novo.
            setParams((antes) => {
              const novo = new URLSearchParams(antes);
              if (v) novo.set('status', v);
              else novo.delete('status');
              return novo;
            })
          }
        />
        <Busca lista={lista} rotulo={t('contas.busca')} />
      </div>
      {acao.falha && (
        <p className="erro" role="alert">
          {acao.falha}
        </p>
      )}
      <Estado
        carregando={carregando}
        erro={erro}
        tem={!!dados}
        vazio={dados?.length === 0 && t('contas.vazio')}
      >
        <div className="rolagem">
          <table>
            <thead>
              <tr>
                <ThOrd lista={lista} chave="conta">
                  {t('col.conta')}
                </ThOrd>
                <ThOrd lista={lista} chave="status">
                  {t('col.status')}
                </ThOrd>
                <ThOrd lista={lista} chave="envia" title={t('col.enviaDica')}>
                  {t('col.envia')}
                </ThOrd>
                <ThOrd lista={lista} chave="bot" title={t('col.botDica')}>
                  {t('col.bot')}
                </ThOrd>
                <ThOrd lista={lista} chave="faixas" className="num">
                  {t('col.faixas')}
                </ThOrd>
                <ThOrd lista={lista} chave="usado">
                  {t('col.ocupacao')}
                </ThOrd>
                <ThOrd lista={lista} chave="atividade">
                  {t('col.atividade')}
                </ThOrd>
                <ThOrd lista={lista} chave="desde">
                  {t('col.desde')}
                </ThOrd>
                <th />
              </tr>
            </thead>
            <tbody>
              {lista.visiveis.map((c) => (
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
                      rotulo={t('contas.podeEnviar', { email: c.email })}
                      desabilitado={acao.ocupado}
                      aoMudar={(v) => fazer(() => api.ajustar(c.id, { podeEnviar: v }))}
                    />
                  </td>
                  <td>
                    <Marca
                      ligado={c.recebeDoBot}
                      rotulo={t('contas.recebeDoBot', { email: c.email })}
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
                        {t('comum.aprovar')}
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
                        {t('comum.negar')}
                      </button>
                    )}
                    {c.status === 'aprovada' && (
                      <Confirmar
                        rotulo={t('comum.suspender')}
                        pergunta={t('contas.suspenderPergunta')}
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
        <NadaCasa lista={lista} />
      </Estado>
    </section>
  );
}
