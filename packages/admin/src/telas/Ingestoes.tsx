import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Estado, Segmentos, useDados } from '../ui';
import { TabelaDeIngestoes } from './Conta';

const FILTROS = [
  { valor: '', rotulo: 'todas' },
  { valor: 'error', rotulo: 'com erro' },
  { valor: 'pending', rotulo: 'na fila' },
  { valor: 'processing', rotulo: 'processando' },
  { valor: 'ready', rotulo: 'prontas' },
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

  return (
    <section>
      <h1>ingestões</h1>
      <div className="linha solta">
        <Segmentos
          rotulo="Filtrar por status"
          opcoes={FILTROS}
          valor={filtro}
          aoMudar={(v) => setParams(v ? { status: v } : {})}
        />
        <button type="button" className="link" onClick={() => void recarregar()}>
          [atualizar]
        </button>
      </div>
      <Estado
        carregando={carregando}
        erro={erro}
        tem={!!dados}
        vazio={dados?.length === 0 && 'nenhuma ingestão neste recorte.'}
      >
        <p className="mudo">as 100 mais recentes. a origem mostra só o site, nunca a URL inteira.</p>
        <TabelaDeIngestoes lista={dados ?? []} />
      </Estado>
    </section>
  );
}
