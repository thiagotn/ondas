import { useState } from 'react';
import { api } from '../api';
import { fmtBytes } from '../formato';
import { Estado, Segmentos, useAcao, useDados } from '../ui';
import { TabelaDeFaixas } from './Conta';

const ORDENS = [
  { valor: 'tamanho', rotulo: 'maiores' },
  { valor: 'recentes', rotulo: 'mais novas' },
] as const;

export function Faixas() {
  const [ordem, setOrdem] = useState<'tamanho' | 'recentes'>('tamanho');
  const { dados, erro, carregando, recarregar } = useDados(() => api.faixas(ordem), [ordem]);
  const acao = useAcao();
  const total = (dados ?? []).reduce((s, f) => s + f.audioBytes + f.capaBytes, 0);

  return (
    <section>
      <h1>faixas</h1>
      <Segmentos rotulo="Ordenar" opcoes={ORDENS} valor={ordem} aoMudar={setOrdem} />
      {acao.falha && (
        <p className="erro" role="alert">
          {acao.falha}
        </p>
      )}
      <Estado
        carregando={carregando}
        erro={erro}
        tem={!!dados}
        vazio={dados?.length === 0 && 'o acervo está vazio.'}
      >
        <p className="mudo">
          {dados?.length} faixa(s) nesta lista, {fmtBytes(total)}. a lista mostra até 200.
        </p>
        <TabelaDeFaixas
          faixas={dados ?? []}
          comDono
          ocupado={acao.ocupado}
          aoApagar={(f) => void acao.rodar(() => api.apagarFaixa(f.id)).then(() => recarregar())}
        />
      </Estado>
    </section>
  );
}
