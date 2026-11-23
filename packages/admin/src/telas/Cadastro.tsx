import { useState, type FormEvent } from 'react';
import { api, type Convite } from '../api';
import { fmtDia } from '../formato';
import { t } from '../i18n';
import { Busca, NadaCasa, ThOrd, useLista, type Config } from '../lista';
import { Confirmar, Estado, Marca, useAcao, useDados } from '../ui';

const LISTA: Config<Convite> = {
  colunas: {
    email: (c) => c.email,
    envia: (c) => c.podeEnviar,
    bot: (c) => c.recebeDoBot,
    nota: (c) => c.nota,
    desde: (c) => c.criadoEm,
  },
  texto: (c) => `${c.email} ${c.nota ?? ''}`,
  descPrimeiro: ['envia', 'bot', 'desde'],
  // A tela tem outras coisas além da lista: as chaves dizem de quem são.
  prefixo: 'c',
};

/**
 * Quem pode pedir conta, e quem já entra aprovado.
 *
 * É o que morava em `SIGNUP_OPEN` e `SIGNUP_ALLOWLIST`, no ConfigMap: aqui a
 * mudança vale no pedido seguinte, sem deploy nem restart.
 */
export function Cadastro() {
  const config = useDados(() => api.config(), []);
  const convites = useDados(() => api.convites(), []);
  const lista = useLista(convites.dados, LISTA);
  const acao = useAcao();

  const [email, setEmail] = useState('');
  const [podeEnviar, setPodeEnviar] = useState(false);
  const [recebeDoBot, setRecebeDoBot] = useState(false);
  const [nota, setNota] = useState('');

  const convidar = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await acao.rodar(() => api.convidar({ email, podeEnviar, recebeDoBot, nota }));
    if (!ok) return;
    setEmail('');
    setNota('');
    setPodeEnviar(false);
    setRecebeDoBot(false);
    void convites.recarregar();
  };

  const aberto = config.dados?.cadastroAberto ?? false;

  return (
    <section>
      <h1>{t('aba.cadastro')}</h1>
      {acao.falha && (
        <p className="erro" role="alert">
          {acao.falha}
        </p>
      )}

      <Estado carregando={config.carregando} erro={config.erro} tem={!!config.dados}>
        <div className="painel">
          <div className="linha">
            <span className="rotulo">{t('cadastro.pedidos')}</span>
            <Marca
              ligado={aberto}
              rotulo={t('cadastro.abertoRotulo')}
              desabilitado={acao.ocupado}
              aoMudar={(v) =>
                void acao.rodar(() => api.definirCadastro(v)).then(() => config.recarregar())
              }
            />
            <span className={aberto ? 'ok' : 'mudo'}>
              {aberto ? t('cadastro.abertoExplica') : t('cadastro.fechadoExplica')}
            </span>
          </div>
        </div>
      </Estado>

      <h2>{t('cadastro.convites')}</h2>
      <p className="mudo">{t('cadastro.convitesExplica')}</p>
      <form className="painel" onSubmit={(e) => void convidar(e)}>
        <div className="linha">
          <span className="rotulo">{t('cadastro.email')}</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-label={t('cadastro.emailRotulo')}
            placeholder={t('cadastro.emailExemplo')}
            autoComplete="off"
            required
            size={28}
          />
        </div>
        <div className="linha">
          <span className="rotulo">{t('cadastro.nasceCom')}</span>
          <Marca ligado={podeEnviar} rotulo={t('cadastro.convitePodeEnviar')} aoMudar={setPodeEnviar} />
          <span className="mudo">{t('cadastro.podeEnviar')}</span>
          <Marca ligado={recebeDoBot} rotulo={t('cadastro.conviteRecebeDoBot')} aoMudar={setRecebeDoBot} />
          <span className="mudo">{t('cadastro.recebeDoBot')}</span>
        </div>
        <div className="linha">
          <span className="rotulo">{t('cadastro.nota')}</span>
          <input
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            aria-label={t('cadastro.notaRotulo')}
            placeholder={t('cadastro.notaExemplo')}
            maxLength={200}
            size={36}
          />
          <button type="submit" className="primario" disabled={acao.ocupado || !email.trim()}>
            {t('cadastro.convidar')}
          </button>
        </div>
      </form>

      <Estado
        carregando={convites.carregando}
        erro={convites.erro}
        tem={!!convites.dados}
        vazio={convites.dados?.length === 0 && t('cadastro.semConvites')}
      >
        <div className="filtros">
          <Busca lista={lista} rotulo={t('cadastro.busca')} />
        </div>
        <div className="rolagem">
          <table>
            <thead>
              <tr>
                <ThOrd lista={lista} chave="email">
                  {t('col.email')}
                </ThOrd>
                <ThOrd lista={lista} chave="envia">
                  {t('col.envia')}
                </ThOrd>
                <ThOrd lista={lista} chave="bot">
                  {t('col.bot')}
                </ThOrd>
                <ThOrd lista={lista} chave="nota">
                  {t('col.nota')}
                </ThOrd>
                <ThOrd lista={lista} chave="desde">
                  {t('col.desde')}
                </ThOrd>
                <th />
              </tr>
            </thead>
            <tbody>
              {lista.visiveis.map((c) => (
                <tr key={c.email}>
                  <td>{c.email}</td>
                  <td className={c.podeEnviar ? 'ok' : 'mudo'}>{c.podeEnviar ? '[x]' : '[ ]'}</td>
                  <td className={c.recebeDoBot ? 'ok' : 'mudo'}>{c.recebeDoBot ? '[x]' : '[ ]'}</td>
                  <td className="mudo">{c.nota || '—'}</td>
                  <td className="mudo">{fmtDia(c.criadoEm)}</td>
                  <td className="acoes">
                    <Confirmar
                      rotulo={t('cadastro.remover')}
                      pergunta={t('cadastro.removerPergunta')}
                      desabilitado={acao.ocupado}
                      aoConfirmar={() =>
                        void acao
                          .rodar(() => api.removerConvite(c.email))
                          .then(() => convites.recarregar())
                      }
                    />
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
