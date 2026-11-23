import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { fmtBytes } from '../formato';
import { t } from '../i18n';
import { Busca, useLista } from '../lista';
import { Estado, Segmentos, useAcao, useDados } from '../ui';
import { LISTA_DE_FAIXAS, TabelaDeFaixas } from './Conta';

/** O teto de `GET /admin/faixas` — o servidor corta aqui. */
const LIMITE = 200;

const ORDENS = [
  { valor: 'tamanho', chave: 'faixas.maiores' },
  { valor: 'recentes', chave: 'faixas.maisNovas' },
] as const;

const VISIBILIDADES = [
  { valor: '', chave: 'faixas.todas' },
  { valor: 'privada', chave: 'faixas.visDono' },
  { valor: 'todos', chave: 'faixas.visTodos' },
] as const;

type Visibilidade = (typeof VISIBILIDADES)[number]['valor'];

export function Faixas() {
  const [params, setParams] = useSearchParams();
  // QUAIS faixas o servidor manda quando o acervo passa do teto: as maiores ou
  // as mais novas. É pedido novo à API, e por isso não é a mesma coisa que
  // clicar numa coluna — que só reordena o que já chegou.
  const [ordem, setOrdem] = useState<'tamanho' | 'recentes'>('tamanho');
  const { dados, erro, carregando, recarregar } = useDados(() => api.faixas(ordem), [ordem]);
  const acao = useAcao();

  const brutoVis = params.get('vis') ?? '';
  const vis: Visibilidade = VISIBILIDADES.some((v) => v.valor === brutoVis)
    ? (brutoVis as Visibilidade)
    : '';
  const recorte = vis ? (dados ?? []).filter((f) => f.visibilidade === vis) : dados;
  const lista = useLista(recorte, LISTA_DE_FAIXAS);

  // A soma é do que está NA TELA: filtrar por um dono responde "quanto ele
  // ocupa" sem sair daqui.
  const total = lista.visiveis.reduce((s, f) => s + f.audioBytes + f.capaBytes, 0);
  const cortada = (dados?.length ?? 0) >= LIMITE;

  return (
    <section>
      <h1>{t('aba.faixas')}</h1>
      <div className="filtros">
        <Segmentos
          rotulo={t('faixas.ordemServidor')}
          opcoes={ORDENS.map((o) => ({ valor: o.valor, rotulo: t(o.chave) }))}
          valor={ordem}
          aoMudar={setOrdem}
        />
        <Segmentos
          rotulo={t('faixas.filtroVisibilidade')}
          opcoes={VISIBILIDADES.map((v) => ({ valor: v.valor, rotulo: t(v.chave) }))}
          valor={vis}
          aoMudar={(v) =>
            setParams((antes) => {
              const novo = new URLSearchParams(antes);
              if (v) novo.set('vis', v);
              else novo.delete('vis');
              return novo;
            })
          }
        />
        <Busca lista={lista} rotulo={t('faixas.busca')} />
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
        vazio={dados?.length === 0 && t('faixas.vazio')}
      >
        <p className="mudo">
          {t('faixas.resumo', { n: lista.visiveis.length, bytes: fmtBytes(total) })}{' '}
          {t('faixas.limite', { n: LIMITE })}
          {/* Só quando o corte aconteceu de verdade: aí o filtro não alcança o
              que ficou de fora, e isso muda a leitura da tela. */}
          {cortada && <> {t('lista.soCarregadas', { n: dados?.length ?? 0 })}</>}
        </p>
        <TabelaDeFaixas
          lista={lista}
          comDono
          ocupado={acao.ocupado}
          aoApagar={(f) => void acao.rodar(() => api.apagarFaixa(f.id)).then(() => recarregar())}
        />
      </Estado>
    </section>
  );
}
