import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Faixa, type Ingestao } from '../api';
import {
  escreverTamanho,
  fmtBytes,
  fmtDia,
  fmtDuracao,
  fmtQuando,
  lerTamanho,
  rotuloStatus,
} from '../formato';
import { t } from '../i18n';
import { Busca, NadaCasa, ThOrd, useLista, type Config, type Lista } from '../lista';
import { Confirmar, Estado, Marca, Uso, useAcao, useDados } from '../ui';

/** Colunas e busca das faixas — as mesmas na tela de faixas e na da conta. */
export const LISTA_DE_FAIXAS: Config<Faixa> = {
  colunas: {
    faixa: (f) => f.titulo,
    dono: (f) => f.donoEmail,
    duracao: (f) => f.duracaoS,
    audio: (f) => f.audioBytes,
    capas: (f) => f.capaBytes,
    visivel: (f) => f.visibilidade,
    desde: (f) => f.criadaEm,
  },
  texto: (f) => `${f.titulo} ${f.artista} ${f.donoEmail} ${f.donoNome}`,
  descPrimeiro: ['duracao', 'audio', 'capas', 'desde'],
};

export function TabelaDeFaixas({
  lista,
  comDono,
  aoApagar,
  ocupado,
}: {
  lista: Lista<Faixa>;
  comDono: boolean;
  aoApagar: (f: Faixa) => void;
  ocupado: boolean;
}) {
  return (
    <>
      <div className="rolagem">
        <table>
          <thead>
            <tr>
              <ThOrd lista={lista} chave="faixa">
                {t('col.faixa')}
              </ThOrd>
              {comDono && (
                <ThOrd lista={lista} chave="dono">
                  {t('col.dono')}
                </ThOrd>
              )}
              <ThOrd lista={lista} chave="duracao" className="num">
                {t('col.duracao')}
              </ThOrd>
              <ThOrd lista={lista} chave="audio" className="num">
                {t('col.audio')}
              </ThOrd>
              <ThOrd lista={lista} chave="capas" className="num">
                {t('col.capas')}
              </ThOrd>
              <ThOrd lista={lista} chave="visivel">
                {t('col.visivel')}
              </ThOrd>
              <ThOrd lista={lista} chave="desde">
                {t('col.desde')}
              </ThOrd>
              <th />
            </tr>
          </thead>
          <tbody>
            {lista.visiveis.map((f) => (
              <tr key={f.id}>
                <td>
                  {f.titulo}
                  <div className="mudo">{f.artista}</div>
                </td>
                {comDono && (
                  <td>
                    <Link to={`/accounts/${f.donoId}`}>{f.donoEmail}</Link>
                  </td>
                )}
                <td className="num">{fmtDuracao(f.duracaoS)}</td>
                <td className="num">{fmtBytes(f.audioBytes)}</td>
                <td className="num mudo">{f.capaBytes ? fmtBytes(f.capaBytes) : '—'}</td>
                <td className={f.visibilidade === 'todos' ? 'aviso' : 'mudo'}>
                  {f.visibilidade === 'todos' ? t('faixas.visTodos') : t('faixas.visDono')}
                </td>
                <td className="mudo">{fmtDia(f.criadaEm)}</td>
                <td className="acoes">
                  <Confirmar
                    rotulo={t('faixas.apagar')}
                    pergunta={t('faixas.apagarPergunta')}
                    desabilitado={ocupado}
                    aoConfirmar={() => aoApagar(f)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <NadaCasa lista={lista} />
    </>
  );
}

/**
 * Link de página ainda na fila do node: "na fila" sozinho esconderia que quem
 * está devendo é o download, não o worker.
 */
function statusDaIngestao(i: Ingestao): string {
  return i.tipo === 'pagina' && i.status !== 'error' && i.status !== 'ready'
    ? t('status.esperandoNode')
    : rotuloStatus(i.status);
}

export const LISTA_DE_INGESTOES: Config<Ingestao> = {
  colunas: {
    quando: (i) => i.criadaEm,
    status: (i) => i.status,
    origem: (i) => i.fonte,
    titulo: (i) => i.titulo,
    pedidoPor: (i) => i.pedidoPor,
    para: (i) => i.destino,
    tentativas: (i) => i.tentativas,
  },
  // O erro entra na busca: é por ele que se acha "todas as que falharam por X".
  texto: (i) =>
    `${i.fonte} ${i.titulo ?? ''} ${i.pedidoPor} ${i.destino ?? ''} ${statusDaIngestao(i)} ${i.erro ?? ''}`,
  descPrimeiro: ['quando', 'tentativas'],
};

export function TabelaDeIngestoes({ lista }: { lista: Lista<Ingestao> }) {
  return (
    <>
      <div className="rolagem">
        <table>
          <thead>
            <tr>
              <ThOrd lista={lista} chave="quando">
                {t('col.quando')}
              </ThOrd>
              <ThOrd lista={lista} chave="status">
                {t('col.status')}
              </ThOrd>
              <ThOrd lista={lista} chave="origem">
                {t('col.origem')}
              </ThOrd>
              <ThOrd lista={lista} chave="titulo">
                {t('col.titulo')}
              </ThOrd>
              <ThOrd lista={lista} chave="pedidoPor">
                {t('col.pedidoPor')}
              </ThOrd>
              <ThOrd lista={lista} chave="para">
                {t('col.para')}
              </ThOrd>
              <ThOrd lista={lista} chave="tentativas" className="num">
                {t('col.tentativas')}
              </ThOrd>
            </tr>
          </thead>
          <tbody>
            {lista.visiveis.map((i) => (
              <tr key={i.id}>
                <td className="mudo">{fmtQuando(i.criadaEm)}</td>
                <td className={`job-${i.status}`}>
                  {statusDaIngestao(i)}
                  {/* O erro é a frase que o worker gravou — texto, nunca HTML. */}
                  {i.erro && <div className="erro">{i.erro}</div>}
                </td>
                <td>{i.fonte}</td>
                <td>{i.titulo || <span className="mudo">—</span>}</td>
                <td className="mudo">{i.pedidoPor}</td>
                <td className="mudo">{i.destino || '—'}</td>
                <td className="num">{i.tentativas}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <NadaCasa lista={lista} />
    </>
  );
}

// Duas tabelas na mesma tela: cada uma com o seu par de chaves no endereço.
const FAIXAS_DA_CONTA: Config<Faixa> = { ...LISTA_DE_FAIXAS, prefixo: 'f' };
const INGESTOES_DA_CONTA: Config<Ingestao> = { ...LISTA_DE_INGESTOES, prefixo: 'i' };

export function ContaDetalhe() {
  const { id = '' } = useParams();
  const navegar = useNavigate();
  const { dados, erro, carregando, recarregar } = useDados(() => api.conta(id), [id]);
  const planos = useDados(() => api.planos(), []);
  const acao = useAcao();
  const [extra, setExtra] = useState('');
  const [confirmaEmail, setConfirmaEmail] = useState('');

  const conta = dados?.conta;
  const faixas = useLista(dados?.faixas, FAIXAS_DA_CONTA);
  const ingestoes = useLista(dados?.ingestoes, INGESTOES_DA_CONTA);
  useEffect(() => {
    if (conta) setExtra(escreverTamanho(conta.cotaExtraBytes));
  }, [conta?.id, conta?.cotaExtraBytes]); // eslint-disable-line react-hooks/exhaustive-deps

  const fazer = (fn: () => Promise<unknown>) => void acao.rodar(fn).then(() => recarregar());

  const extraLido = lerTamanho(extra);

  return (
    <section>
      <p>
        <Link to="/accounts">{t('conta.voltar')}</Link>
      </p>
      <Estado carregando={carregando} erro={erro} tem={!!conta}>
        {conta && dados && (
          <>
            <h1>{conta.email}</h1>
            {acao.falha && (
              <p className="erro" role="alert">
                {acao.falha}
              </p>
            )}

            <div className="painel">
              <div className="linha">
                <span className="rotulo">{t('conta.nome')}</span>
                <span>{conta.name}</span>
              </div>
              <div className="linha">
                <span className="rotulo">{t('conta.status')}</span>
                <span className={`status-${conta.status}`}>{rotuloStatus(conta.status)}</span>
                <span className="acoes">
                  {conta.status !== 'aprovada' && (
                    <button
                      type="button"
                      className="primario"
                      disabled={acao.ocupado}
                      onClick={() => fazer(() => api.aprovar(conta.id))}
                    >
                      {t('comum.aprovar')}
                    </button>
                  )}
                  {conta.status !== 'negada' && (
                    <Confirmar
                      rotulo={conta.status === 'aprovada' ? t('comum.suspender') : t('comum.negar')}
                      pergunta={t('conta.deixaDeEntrar')}
                      desabilitado={acao.ocupado}
                      aoConfirmar={() => fazer(() => api.negar(conta.id))}
                    />
                  )}
                </span>
              </div>
              {conta.mensagem && (
                <div className="linha">
                  <span className="rotulo">{t('conta.pedido')}</span>
                  <span className="citacao">“{conta.mensagem}”</span>
                </div>
              )}
              <div className="linha">
                <span className="rotulo">{t('conta.envio')}</span>
                <Marca
                  ligado={conta.podeEnviar}
                  rotulo={t('conta.podeEnviarRotulo')}
                  desabilitado={acao.ocupado}
                  aoMudar={(v) => fazer(() => api.ajustar(conta.id, { podeEnviar: v }))}
                />
                <span className="mudo">{t('conta.podeEnviarExplica')}</span>
              </div>
              <div className="linha">
                <span className="rotulo">{t('conta.bot')}</span>
                <Marca
                  ligado={conta.recebeDoBot}
                  rotulo={t('conta.recebeDoBotRotulo')}
                  desabilitado={acao.ocupado}
                  aoMudar={(v) => fazer(() => api.ajustar(conta.id, { recebeDoBot: v }))}
                />
                <span className="mudo">{t('conta.recebeDoBotExplica')}</span>
              </div>
              <div className="linha">
                <span className="rotulo">{t('conta.plano')}</span>
                <select
                  value={conta.planoId}
                  disabled={acao.ocupado || !planos.dados}
                  aria-label={t('conta.planoRotulo')}
                  onChange={(e) => fazer(() => api.ajustar(conta.id, { planoId: e.target.value }))}
                >
                  {(planos.dados ?? [{ id: conta.planoId, nome: conta.planoNome, cotaBytes: 0 }]).map(
                    (p) => (
                      <option key={p.id} value={p.id}>
                        {p.nome}
                        {p.cotaBytes ? ` — ${fmtBytes(p.cotaBytes)}` : ''}
                      </option>
                    ),
                  )}
                </select>
              </div>
              <form
                className="linha"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (extraLido !== null) {
                    fazer(() => api.ajustar(conta.id, { cotaExtraBytes: extraLido }));
                  }
                }}
              >
                <span className="rotulo">{t('conta.extra')}</span>
                <input
                  value={extra}
                  onChange={(e) => setExtra(e.target.value)}
                  aria-label={t('conta.extraRotulo')}
                  placeholder="0, 500 MB, 2 GB"
                  size={12}
                />
                <button
                  type="submit"
                  className="link"
                  disabled={acao.ocupado || extraLido === null || extraLido === conta.cotaExtraBytes}
                >
                  {t('comum.salvar')}
                </button>
                <span className={extraLido === null ? 'erro' : 'mudo'}>
                  {extraLido === null ? t('comum.naoEntendiTamanho') : t('conta.extraExplica')}
                </span>
              </form>
              <div className="linha">
                <span className="rotulo">{t('conta.ocupacao')}</span>
                <Uso usado={conta.usadoBytes} cota={conta.cotaBytes} />
                <span className="mudo">{t('conta.nFaixas', { n: conta.faixas })}</span>
              </div>
              <div className="linha">
                <span className="rotulo">{t('conta.atividade')}</span>
                <span className="mudo">
                  {t('conta.atividadeResumo', {
                    criada: fmtDia(conta.criadaEm),
                    login: fmtQuando(conta.ultimoLoginEm),
                    escuta: fmtQuando(conta.ultimaEscutaEm),
                  })}
                </span>
              </div>
            </div>

            <h2>{t('conta.faixas')}</h2>
            {dados.faixas.length === 0 ? (
              <p className="mudo">{t('conta.semFaixas')}</p>
            ) : (
              <>
                <div className="filtros">
                  <Busca lista={faixas} rotulo={t('conta.buscaFaixas')} />
                </div>
                <TabelaDeFaixas
                  lista={faixas}
                  comDono={false}
                  ocupado={acao.ocupado}
                  aoApagar={(f) => fazer(() => api.apagarFaixa(f.id))}
                />
              </>
            )}

            <h2>{t('conta.ingestoes')}</h2>
            {dados.ingestoes.length === 0 ? (
              <p className="mudo">{t('conta.semIngestoes')}</p>
            ) : (
              <>
                <div className="filtros">
                  <Busca lista={ingestoes} rotulo={t('conta.buscaIngestoes')} />
                </div>
                <TabelaDeIngestoes lista={ingestoes} />
              </>
            )}

            <h2 className="erro">{t('conta.apagar')}</h2>
            <p className="mudo">{t('conta.apagarExplica', { n: conta.faixas })}</p>
            <div className="linha solta">
              <input
                value={confirmaEmail}
                onChange={(e) => setConfirmaEmail(e.target.value)}
                aria-label={t('conta.confirmaEmail')}
                placeholder={conta.email}
                autoComplete="off"
                size={28}
              />
              <button
                type="button"
                className="perigo"
                disabled={acao.ocupado || confirmaEmail.trim().toLowerCase() !== conta.email.toLowerCase()}
                onClick={() =>
                  void acao.rodar(() => api.apagarConta(conta.id)).then((ok) => {
                    if (ok) navegar('/accounts');
                  })
                }
              >
                {t('conta.apagarDeVez')}
              </button>
            </div>
          </>
        )}
      </Estado>
    </section>
  );
}
