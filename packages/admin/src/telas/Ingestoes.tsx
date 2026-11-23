import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { t } from '../i18n';
import { Busca, useLista } from '../lista';
import { Estado, Segmentos, useDados } from '../ui';
import { LISTA_DE_INGESTOES, TabelaDeIngestoes } from './Conta';

const FILTROS = [
  { valor: '', chave: 'ingestoes.todas' },
  { valor: 'error', chave: 'ingestoes.comErro' },
  { valor: 'pending', chave: 'ingestoes.naFila' },
  { valor: 'processing', chave: 'ingestoes.processando' },
  { valor: 'ready', chave: 'ingestoes.prontas' },
] as const;

type Filtro = (typeof FILTROS)[number]['valor'];

export function Ingestoes() {
  const [params, setParams] = useSearchParams();
  const bruto = params.get('status') ?? '';
  const filtro: Filtro = FILTROS.some((f) => f.valor === bruto) ? (bruto as Filtro) : '';
  const { dados, erro, carregando, recarregar } = useDados(
    () => api.ingestoes(filtro || undefined),
    [filtro],
  );
  const lista = useLista(dados, LISTA_DE_INGESTOES);

  return (
    <section>
      <h1>{t('aba.ingestoes')}</h1>
      <div className="filtros">
        <Segmentos
          rotulo={t('ingestoes.filtroStatus')}
          opcoes={FILTROS.map((f) => ({ valor: f.valor, rotulo: t(f.chave) }))}
          valor={filtro}
          aoMudar={(v) =>
            setParams((antes) => {
              const novo = new URLSearchParams(antes);
              if (v) novo.set('status', v);
              else novo.delete('status');
              return novo;
            })
          }
        />
        <Busca lista={lista} rotulo={t('ingestoes.busca')} />
        <button type="button" className="link" onClick={() => void recarregar()}>
          {t('comum.atualizar')}
        </button>
      </div>
      <Estado
        carregando={carregando}
        erro={erro}
        tem={!!dados}
        vazio={dados?.length === 0 && t('ingestoes.vazio')}
      >
        <p className="mudo">{t('ingestoes.explica')}</p>
        <TabelaDeIngestoes lista={lista} />
      </Estado>
    </section>
  );
}
