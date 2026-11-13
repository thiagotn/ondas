import {
  fmtMB,
  offlineBytes,
  planLabel,
  showsPublicCatalog,
  storageLabel,
  t,
  whoAmI,
  type OfflineUsage,
} from '@ondas/core';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as controller from '../app/controller';
import { useGuestMode } from '../app/guest';
import { offlineStore } from '../app/services';
import { libraryStore, useLibrary, useSession } from '../app/stores';
import { useAccountOverlay } from '../hooks/useAccountOverlay';
import { useWide } from '../hooks/useWide';
import { PATHS } from '../routes/paths';
import { ApagarConta, LinhasDaConta, Renomear } from './ContaPropria';
import o from './overlay.module.css';
import s from './shell.module.css';

/**
 * `ondas whoami` — conta e aparelho, fora da biblioteca.
 *
 * Os dois blocos estão separados porque são coisas diferentes de verdade: a
 * conta vive no servidor e te segue para qualquer aparelho; `buffer` e os
 * downloads vivem no IndexedDB **deste navegador** e não seguem ninguém.
 * Juntá-los num painel só, como estava na biblioteca, insinuava uma sincronia
 * que não existe.
 *
 * A curtida já esteve na lista de baixo e mudou de lado (migração 0006): ela
 * segue a conta, e o que fica no aparelho é só o espelho dela.
 */
export function AccountOverlay() {
  const navigate = useNavigate();
  const wide = useWide();
  const { closeAccount } = useAccountOverlay();
  const user = useSession((st) => st.user);
  const leaveGuest = useGuestMode((st) => st.leaveGuest);
  const prefetch = useLibrary((st) => st.prefetch);
  const publico = showsPublicCatalog(user);
  const cached = useLibrary((st) => st.cached);
  const sizes = useLibrary((st) => st.sizes);
  const [confirmando, setConfirmando] = useState(false);

  const count = Object.keys(cached).length;
  const espaco = useEspaco(count);

  return (
    <div className={o.backdrop} onClick={closeAccount} role="presentation">
      <div
        className={o.conta}
        role="dialog"
        aria-modal="true"
        aria-label="ondas whoami"
        onClick={(e) => e.stopPropagation()}
      >
        <span className={o.label}>ondas whoami</span>
        <button type="button" className={o.close} onClick={closeAccount}>
          {t(wide ? 'ui.fecharEsc' : 'ui.fechar')}
        </button>

        <div className={o.contaCorpo}>
          <div className={s.panel}>
            <div className={s.panelRow}>
              <span className={s.panelLabel}>{t('conta.conta')}</span>
              <span className={s.panelValue}>{whoAmI(user)}</span>
              {user ? (
                <>
                  <Renomear user={user} />
                  <button
                    type="button"
                    className={s.logout}
                    onClick={() => {
                      void controller.logout();
                      leaveGuest();
                      navigate(PATHS.login);
                    }}
                  >
                    {t('ui.sair')}
                  </button>
                </>
              ) : (
                <button type="button" className={s.link} onClick={() => navigate(PATHS.login)}>
                  {t('ui.entrar')}
                </button>
              )}
            </div>
            <div className={s.panelRow}>
              <span className={s.panelLabel}>{t('conta.plano')}</span>
              <span className={s.panelValue}>{planLabel(user)}</span>
            </div>

            {/* O que a conta muda em si mesma. Acima do divisor pela mesma
                razão do catálogo, logo abaixo: é do servidor, e segue a pessoa. */}
            {user && <LinhasDaConta user={user} />}

            {/* Fica NESTE painel, acima do divisor, porque é um campo da conta:
                desligar aqui vale no celular também. O `buffer`, logo abaixo do
                divisor, é do navegador — e é essa a diferença que o rótulo
                `# aparelho` existe para não deixar implícita. */}
            {user && (
              <button
                type="button"
                className={`${s.panelRow} ${s.panelButton}`}
                aria-pressed={publico}
                onClick={() => void controller.togglePublico()}
              >
                <span className={s.panelLabel}>{t('conta.catalogo')}</span>
                <span className={publico ? s.checkOn : s.checkOff}>{publico ? '[x]' : '[ ]'}</span>
                <span className={s.panelValue}>{t('conta.catalogoPublico')}</span>
              </button>
            )}
          </div>

          {/* O rótulo não é enfeite: é o que diz que nada abaixo dele viaja
              junto com a conta. */}
          <span className={o.contaSecao}>{t('conta.aparelho')}</span>

          <div className={s.panel}>
            <button
              type="button"
              className={`${s.panelRow} ${s.panelButton}`}
              aria-pressed={prefetch}
              onClick={() => libraryStore.getState().togglePrefetch()}
            >
              <span className={s.panelLabel}>{t('conta.buffer')}</span>
              <span className={prefetch ? s.checkOn : s.checkOff}>{prefetch ? '[x]' : '[ ]'}</span>
              <span className={s.panelValue}>{t('conta.bufferDesc')}</span>
            </button>

            <div className={s.panelRow}>
              <span className={s.panelLabel}>{t('conta.offline')}</span>
              <span className={s.panelValue}>
                {t('playlist.faixas', { n: count })} · {fmtMB(offlineBytes({ cached, sizes }))}
              </span>
              {count > 0 && (
                <span className={o.contaLimpar}>
                  {/* Dois toques, e não um `confirm()`: apagar não dá para
                      desfazer, e a caixa nativa do navegador destoaria de
                      tudo aqui. */}
                  {confirmando ? (
                    <>
                      <span className={o.contaConfirma}>
                        {t('conta.apagarQuantas', { n: count })}
                      </span>
                      <button
                        type="button"
                        className={s.logout}
                        onClick={() => {
                          setConfirmando(false);
                          void controller.clearDownloads();
                        }}
                      >
                        {t('ui.sim')}
                      </button>
                      <button
                        type="button"
                        className={s.link}
                        onClick={() => setConfirmando(false)}
                      >
                        {t('ui.nao')}
                      </button>
                    </>
                  ) : (
                    <button type="button" className={s.link} onClick={() => setConfirmando(true)}>
                      {t('conta.limparDownloads')}
                    </button>
                  )}
                </span>
              )}
            </div>

            <div className={s.panelRow}>
              <span className={s.panelLabel}>{t('conta.espaco')}</span>
              <span className={s.panelValue}>{storageLabel(espaco)}</span>
            </div>
          </div>

          {/* Sair não leva os downloads embora — e isso tem de estar escrito,
              porque o áudio do acervo é privado e fica no aparelho. As
              curtidas saíram desta frase quando viraram da conta: sair APAGA
              as deste navegador, e entrar de novo as traz de volta. */}
          {user && count > 0 && <span className={o.contaSecao}>{t('conta.sairNaoApaga')}</span>}

          {/* Por último, depois de tudo que é reversível. Dá no mesmo lugar que
              o `[sair]`: sem sessão não há o que este painel mostrar. */}
          {user && (
            <ApagarConta
              aoApagar={() => {
                leaveGuest();
                navigate(PATHS.login);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Espaço do navegador para esta origem.
 *
 * `navigator.storage.estimate()` é assíncrono e mede a origem INTEIRA — não
 * só as faixas —, daí ficar numa linha própria em vez de encostar no total de
 * downloads, que é outra conta. Remede quando o número de faixas muda: é o
 * sinal de que alguém baixou ou limpou.
 */
function useEspaco(faixas: number): OfflineUsage | null {
  const [uso, setUso] = useState<OfflineUsage | null>(null);

  useEffect(() => {
    let vivo = true;
    void offlineStore.usage().then((u) => {
      if (vivo) setUso(u);
    });
    return () => {
      vivo = false;
    };
  }, [faixas]);

  return uso;
}
