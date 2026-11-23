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
import { Confirmar, Estado, Marca, Uso, useAcao, useDados } from '../ui';

export function TabelaDeFaixas({
  faixas,
  comDono,
  aoApagar,
  ocupado,
}: {
  faixas: Faixa[];
  comDono: boolean;
  aoApagar: (f: Faixa) => void;
  ocupado: boolean;
}) {
  return (
    <div className="rolagem">
      <table>
        <thead>
          <tr>
            <th>faixa</th>
            {comDono && <th>dono</th>}
            <th className="num">duração</th>
            <th className="num">áudio</th>
            <th className="num">capas</th>
            <th>visível para</th>
            <th>desde</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {faixas.map((f) => (
            <tr key={f.id}>
              <td>
                {f.titulo}
                <div className="mudo">{f.artista}</div>
              </td>
              {comDono && (
                <td>
                  <Link to={`/contas/${f.donoId}`}>{f.donoEmail}</Link>
                </td>
              )}
              <td className="num">{fmtDuracao(f.duracaoS)}</td>
              <td className="num">{fmtBytes(f.audioBytes)}</td>
              <td className="num mudo">{f.capaBytes ? fmtBytes(f.capaBytes) : '—'}</td>
              <td className={f.visibilidade === 'todos' ? 'aviso' : 'mudo'}>
                {f.visibilidade === 'todos' ? 'todos' : 'só o dono'}
              </td>
              <td className="mudo">{fmtDia(f.criadaEm)}</td>
              <td className="acoes">
                <Confirmar
                  rotulo="[apagar]"
                  pergunta="sai do acervo e do bucket, sem volta. apagar?"
                  desabilitado={ocupado}
                  aoConfirmar={() => aoApagar(f)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TabelaDeIngestoes({ lista }: { lista: Ingestao[] }) {
  return (
    <div className="rolagem">
      <table>
        <thead>
          <tr>
            <th>quando</th>
            <th>status</th>
            <th>origem</th>
            <th>título</th>
            <th>pedido por</th>
            <th>para</th>
            <th className="num">tentativas</th>
          </tr>
        </thead>
        <tbody>
          {lista.map((i) => (
            <tr key={i.id}>
              <td className="mudo">{fmtQuando(i.criadaEm)}</td>
              <td className={`job-${i.status}`}>
                {/* Link de página ainda na fila do node: "na fila" sozinho
                    esconderia que quem está devendo é o download, não o worker. */}
                {i.tipo === 'pagina' && i.status !== 'error' && i.status !== 'ready'
                  ? 'esperando o node baixar'
                  : rotuloStatus(i.status)}
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
  );
}

export function ContaDetalhe() {
  const { id = '' } = useParams();
  const navegar = useNavigate();
  const { dados, erro, carregando, recarregar } = useDados(() => api.conta(id), [id]);
  const planos = useDados(() => api.planos(), []);
  const acao = useAcao();
  const [extra, setExtra] = useState('');
  const [confirmaEmail, setConfirmaEmail] = useState('');

  const conta = dados?.conta;
  useEffect(() => {
    if (conta) setExtra(escreverTamanho(conta.cotaExtraBytes));
  }, [conta?.id, conta?.cotaExtraBytes]); // eslint-disable-line react-hooks/exhaustive-deps

  const fazer = (fn: () => Promise<unknown>) => void acao.rodar(fn).then(() => recarregar());

  const extraLido = lerTamanho(extra);

  return (
    <section>
      <p>
        <Link to="/contas">← contas</Link>
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
                <span className="rotulo">nome</span>
                <span>{conta.name}</span>
              </div>
              <div className="linha">
                <span className="rotulo">status</span>
                <span className={`status-${conta.status}`}>{rotuloStatus(conta.status)}</span>
                <span className="acoes">
                  {conta.status !== 'aprovada' && (
                    <button
                      type="button"
                      className="primario"
                      disabled={acao.ocupado}
                      onClick={() => fazer(() => api.aprovar(conta.id))}
                    >
                      [aprovar]
                    </button>
                  )}
                  {conta.status !== 'negada' && (
                    <Confirmar
                      rotulo={conta.status === 'aprovada' ? '[suspender]' : '[negar]'}
                      pergunta="a conta deixa de entrar. confirmar?"
                      desabilitado={acao.ocupado}
                      aoConfirmar={() => fazer(() => api.negar(conta.id))}
                    />
                  )}
                </span>
              </div>
              {conta.mensagem && (
                <div className="linha">
                  <span className="rotulo">pedido</span>
                  <span className="citacao">“{conta.mensagem}”</span>
                </div>
              )}
              <div className="linha">
                <span className="rotulo">envio</span>
                <Marca
                  ligado={conta.podeEnviar}
                  rotulo="pode enviar arquivo"
                  desabilitado={acao.ocupado}
                  aoMudar={(v) => fazer(() => api.ajustar(conta.id, { podeEnviar: v }))}
                />
                <span className="mudo">pode enviar arquivo e pedir ingestão de URL</span>
              </div>
              <div className="linha">
                <span className="rotulo">bot</span>
                <Marca
                  ligado={conta.recebeDoBot}
                  rotulo="recebe do bot"
                  desabilitado={acao.ocupado}
                  aoMudar={(v) => fazer(() => api.ajustar(conta.id, { recebeDoBot: v }))}
                />
                <span className="mudo">o bot do Telegram pode publicar faixa para esta conta</span>
              </div>
              <div className="linha">
                <span className="rotulo">plano</span>
                <select
                  value={conta.planoId}
                  disabled={acao.ocupado || !planos.dados}
                  aria-label="Plano da conta"
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
                <span className="rotulo">extra</span>
                <input
                  value={extra}
                  onChange={(e) => setExtra(e.target.value)}
                  aria-label="Cota extra avulsa"
                  placeholder="0, 500 MB, 2 GB"
                  size={12}
                />
                <button
                  type="submit"
                  className="link"
                  disabled={acao.ocupado || extraLido === null || extraLido === conta.cotaExtraBytes}
                >
                  [salvar]
                </button>
                <span className={extraLido === null ? 'erro' : 'mudo'}>
                  {extraLido === null
                    ? 'não entendi o tamanho'
                    : 'espaço avulso, somado ao do plano'}
                </span>
              </form>
              <div className="linha">
                <span className="rotulo">ocupação</span>
                <Uso usado={conta.usadoBytes} cota={conta.cotaBytes} />
                <span className="mudo">{conta.faixas} faixa(s)</span>
              </div>
              <div className="linha">
                <span className="rotulo">atividade</span>
                <span className="mudo">
                  conta de {fmtDia(conta.criadaEm)} · último login {fmtQuando(conta.ultimoLoginEm)} ·
                  última escuta {fmtQuando(conta.ultimaEscutaEm)}
                </span>
              </div>
            </div>

            <h2>faixas</h2>
            {dados.faixas.length === 0 ? (
              <p className="mudo">esta conta não tem faixa no acervo.</p>
            ) : (
              <TabelaDeFaixas
                faixas={dados.faixas}
                comDono={false}
                ocupado={acao.ocupado}
                aoApagar={(f) => fazer(() => api.apagarFaixa(f.id))}
              />
            )}

            <h2>ingestões recentes</h2>
            {dados.ingestoes.length === 0 ? (
              <p className="mudo">nenhuma ingestão desta conta.</p>
            ) : (
              <TabelaDeIngestoes lista={dados.ingestoes} />
            )}

            <h2 className="erro">apagar a conta</h2>
            <p className="mudo">
              apaga a conta, as {conta.faixas} faixa(s) dela e os arquivos no bucket. não tem volta.
              para confirmar, digite o e-mail da conta.
            </p>
            <div className="linha solta">
              <input
                value={confirmaEmail}
                onChange={(e) => setConfirmaEmail(e.target.value)}
                aria-label="E-mail da conta, para confirmar"
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
                    if (ok) navegar('/contas');
                  })
                }
              >
                [apagar de vez]
              </button>
            </div>
          </>
        )}
      </Estado>
    </section>
  );
}
