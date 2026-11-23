import { api, type Evento } from '../api';
import { fmtQuando, rotuloAcao } from '../formato';
import { t } from '../i18n';
import { Busca, NadaCasa, ThOrd, useLista, type Config } from '../lista';
import { Estado, useDados } from '../ui';

const LISTA: Config<Evento> = {
  colunas: {
    quando: (e) => e.em,
    oQue: (e) => `${rotuloAcao(e.acao)} ${e.alvoRotulo ?? ''}`,
    detalhe: (e) => e.detalhe,
    ip: (e) => e.ip,
  },
  texto: (e) => `${rotuloAcao(e.acao)} ${e.alvoRotulo ?? ''} ${e.detalhe ?? ''} ${e.ip ?? ''}`,
  descPrimeiro: ['quando'],
};

/** O que foi decidido por aqui (e pela `ondasctl`), do mais recente para trás. */
export function Historico() {
  const { dados, erro, carregando } = useDados(() => api.eventos(), []);
  const lista = useLista(dados, LISTA);

  return (
    <section>
      <h1>{t('aba.historico')}</h1>
      <p className="mudo">{t('historico.explica')}</p>
      <div className="filtros">
        <Busca lista={lista} rotulo={t('historico.busca')} />
      </div>
      <Estado
        carregando={carregando}
        erro={erro}
        tem={!!dados}
        vazio={dados?.length === 0 && t('historico.vazio')}
      >
        <div className="rolagem">
          <table>
            <thead>
              <tr>
                <ThOrd lista={lista} chave="quando">
                  {t('col.quando')}
                </ThOrd>
                <ThOrd lista={lista} chave="oQue">
                  {t('col.oQue')}
                </ThOrd>
                <ThOrd lista={lista} chave="detalhe">
                  {t('col.detalhe')}
                </ThOrd>
                <ThOrd lista={lista} chave="ip">
                  {t('col.ip')}
                </ThOrd>
              </tr>
            </thead>
            <tbody>
              {lista.visiveis.map((e) => (
                <tr key={e.id}>
                  <td className="mudo">{fmtQuando(e.em)}</td>
                  <td>
                    {rotuloAcao(e.acao)} {e.alvoRotulo && <strong>{e.alvoRotulo}</strong>}
                  </td>
                  <td className="mudo">{e.detalhe || '—'}</td>
                  <td className="mudo">{e.ip || '—'}</td>
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
