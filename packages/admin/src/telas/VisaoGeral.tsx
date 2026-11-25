import { Link } from 'react-router-dom';
import { api, type Conta } from '../api';
import { fmtBytes } from '../formato';
import { t } from '../i18n';
import { ThOrd, useLista, type Config } from '../lista';
import { Estado, Uso, useDados } from '../ui';

const LISTA: Config<Conta> = {
  colunas: {
    conta: (c) => c.email,
    faixas: (c) => c.faixas,
    usado: (c) => c.usadoBytes,
    plano: (c) => c.planoNome,
  },
  texto: (c) => c.email,
  descPrimeiro: ['faixas', 'usado'],
};

/** A primeira tela: o tamanho de tudo, e o que está esperando por você. */
export function VisaoGeral() {
  const resumo = useDados(() => api.resumo(), []);
  const contas = useDados(() => api.contas(), []);
  const r = resumo.dados;

  // Quem mais ocupa. A lista de contas já traz o uso de cada uma, então a
  // ordenação é daqui — não vale uma rota só para isso. As colunas reordenam
  // estas oito, não escolhem outras: o recorte é sempre o dos maiores.
  const maiores = [...(contas.dados ?? [])]
    .filter((c) => c.usadoBytes > 0)
    .sort((a, b) => b.usadoBytes - a.usadoBytes)
    .slice(0, 8);
  const lista = useLista(maiores, LISTA);

  return (
    <section>
      <h1>{t('aba.visaoGeral')}</h1>
      <Estado carregando={resumo.carregando} erro={resumo.erro} tem={!!r}>
        {r && (
          <div className="cartoes">
            <Link className="cartao" to="/accounts?status=pendente">
              <span className="rotulo">{t('geral.pedidos')}</span>
              <span className={r.contas['pendente'] ? 'numero aviso' : 'numero'}>
                {r.contas['pendente'] ?? 0}
              </span>
              <span className="mudo">
                {t('geral.pedidosResumo', {
                  aprovadas: r.contas['aprovada'] ?? 0,
                  negadas: r.contas['negada'] ?? 0,
                })}
              </span>
            </Link>
            <Link className="cartao" to="/tracks">
              <span className="rotulo">{t('geral.armazenamento')}</span>
              <span className="numero">{fmtBytes(r.audioBytes + r.capaBytes)}</span>
              <span className="mudo">
                {t('geral.armazenamentoResumo', {
                  faixas: r.faixas,
                  audio: fmtBytes(r.audioBytes),
                  capas: fmtBytes(r.capaBytes),
                })}
              </span>
            </Link>
            <Link className="cartao" to="/ingestions?status=error">
              <span className="rotulo">{t('geral.ingestoes')}</span>
              <span className={r.ingestoes['error'] ? 'numero erro' : 'numero'}>
                {t('geral.comErro', { n: r.ingestoes['error'] ?? 0 })}
              </span>
              <span className="mudo">
                {t('geral.ingestoesResumo', {
                  fila: (r.ingestoes['pending'] ?? 0) + (r.ingestoes['processing'] ?? 0),
                  prontas: r.ingestoes['ready'] ?? 0,
                })}
              </span>
            </Link>
            <Link className="cartao" to="/signup">
              <span className="rotulo">{t('geral.cadastro')}</span>
              <span className={r.cadastroAberto ? 'numero ok' : 'numero'}>
                {r.cadastroAberto ? t('geral.aberto') : t('geral.fechado')}
              </span>
              <span className="mudo">{t('geral.convites', { n: r.convites })}</span>
            </Link>
            <Link className="cartao" to="/accounts?ord=-usado">
              <span className="rotulo">{t('geral.acimaDaCota')}</span>
              <span className={r.acimaDaCota ? 'numero aviso' : 'numero'}>{r.acimaDaCota}</span>
              <span className="mudo">{t('geral.bloqueioEmPlanos')}</span>
            </Link>
          </div>
        )}
      </Estado>

      <h2>{t('geral.quemMaisOcupa')}</h2>
      <Estado
        carregando={contas.carregando}
        erro={contas.erro}
        tem={!!contas.dados}
        vazio={maiores.length === 0 && t('geral.ninguemOcupa')}
      >
        <div className="rolagem">
          <table>
            <thead>
              <tr>
                <ThOrd lista={lista} chave="conta">
                  {t('col.conta')}
                </ThOrd>
                <ThOrd lista={lista} chave="faixas" className="num">
                  {t('col.faixas')}
                </ThOrd>
                <ThOrd lista={lista} chave="usado">
                  {t('col.ocupacao')}
                </ThOrd>
                <ThOrd lista={lista} chave="plano">
                  {t('col.plano')}
                </ThOrd>
              </tr>
            </thead>
            <tbody>
              {lista.visiveis.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/accounts/${c.id}`}>{c.email}</Link>
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
