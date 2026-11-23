import { useState, type FormEvent } from 'react';
import { api, type Plano } from '../api';
import { escreverTamanho, fmtBytes, lerTamanho } from '../formato';
import { t } from '../i18n';
import { ThOrd, useLista, type Config } from '../lista';
import { Estado, Marca, useAcao, useDados } from '../ui';

// Sem busca: plano se conta nos dedos. A ordem por coluna responde a única
// pergunta que a lista tem — qual é o maior, e qual tem mais gente.
const LISTA: Config<Plano> = {
  colunas: {
    id: (p) => p.id,
    nome: (p) => p.nome,
    cota: (p) => p.cotaBytes,
    contas: (p) => p.contas,
  },
  texto: (p) => `${p.id} ${p.nome}`,
  descPrimeiro: ['cota', 'contas'],
};

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
  const lista = useLista(dados, LISTA);
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
      <h1>{t('aba.planos')}</h1>
      <p className="mudo">{t('planos.formula')}</p>
      {acao.falha && (
        <p className="erro" role="alert">
          {acao.falha}
        </p>
      )}
      <Estado carregando={config.carregando} erro={config.erro} tem={!!config.dados}>
        <div className="painel">
          <div className="linha">
            <span className="rotulo">{t('planos.limite')}</span>
            <Marca
              ligado={bloqueia}
              rotulo={t('planos.bloqueiaRotulo')}
              desabilitado={acao.ocupado}
              aoMudar={(v) =>
                void acao.rodar(() => api.definirCotaBloqueia(v)).then(() => config.recarregar())
              }
            />
            <span className={bloqueia ? 'aviso' : 'mudo'}>
              {bloqueia ? t('planos.bloqueiaExplica') : t('planos.soMedeExplica')}
            </span>
          </div>
        </div>
      </Estado>
      <Estado carregando={carregando} erro={erro} tem={!!dados}>
        <div className="rolagem">
          <table>
            <thead>
              <tr>
                <ThOrd lista={lista} chave="id">
                  {t('col.id')}
                </ThOrd>
                <ThOrd lista={lista} chave="nome">
                  {t('col.nome')}
                </ThOrd>
                <ThOrd lista={lista} chave="cota">
                  {t('col.cota')}
                </ThOrd>
                <ThOrd lista={lista} chave="contas" className="num">
                  {t('col.contas')}
                </ThOrd>
              </tr>
            </thead>
            <tbody>
              {lista.visiveis.map((p) => (
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

      <h2>{t('planos.novo')}</h2>
      <form className="painel" onSubmit={(e) => void criar(e)}>
        <div className="linha">
          <span className="rotulo">{t('col.id')}</span>
          <input
            value={id}
            onChange={(e) => setId(e.target.value.toLowerCase())}
            aria-label={t('planos.idRotulo')}
            placeholder={t('planos.idExemplo')}
            pattern="[a-z0-9-]{1,32}"
            required
            size={14}
          />
          <span className="mudo">{t('planos.idExplica')}</span>
        </div>
        <div className="linha">
          <span className="rotulo">{t('col.nome')}</span>
          <input
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            aria-label={t('planos.nomeRotulo')}
            placeholder={t('planos.nomeExemplo')}
            maxLength={40}
            required
            size={20}
          />
        </div>
        <div className="linha">
          <span className="rotulo">{t('col.cota')}</span>
          <input
            value={cota}
            onChange={(e) => setCota(e.target.value)}
            aria-label={t('planos.cotaRotulo')}
            placeholder={t('planos.cotaExemplo')}
            required
            size={12}
          />
          <button
            type="submit"
            className="primario"
            disabled={acao.ocupado || !id || !nome.trim() || cotaLida === null}
          >
            {t('planos.criar')}
          </button>
          {cota && cotaLida === null && <span className="erro">{t('comum.naoEntendiTamanho')}</span>}
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
          aria-label={t('planos.nomeDoPlano', { id: plano.id })}
          maxLength={40}
          size={16}
        />
      </td>
      <td>
        <input
          value={cota}
          onChange={(e) => setCota(e.target.value)}
          aria-label={t('planos.cotaDoPlano', { id: plano.id })}
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
          {t('comum.salvar')}
        </button>{' '}
        <span className={cotaLida === null ? 'erro' : 'mudo'}>
          {cotaLida === null ? t('comum.naoEntendi') : fmtBytes(cotaLida)}
        </span>
      </td>
      <td className="num">{plano.contas}</td>
    </tr>
  );
}
