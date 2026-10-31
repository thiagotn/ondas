import {
  fmtMB,
  offlineBytes,
  planLabel,
  showsPublicCatalog,
  storageLabel,
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
          {wide ? '[esc] fechar' : 'fechar'}
        </button>

        <div className={o.contaCorpo}>
          <div className={s.panel}>
            <div className={s.panelRow}>
              <span className={s.panelLabel}>conta</span>
              <span className={s.panelValue}>{whoAmI(user)}</span>
              {user ? (
                <button
                  type="button"
                  className={s.logout}
                  onClick={() => {
                    void controller.logout();
                    leaveGuest();
                    navigate(PATHS.login);
                  }}
                >
                  [sair]
                </button>
              ) : (
                <button type="button" className={s.link} onClick={() => navigate(PATHS.login)}>
                  [entrar]
                </button>
              )}
            </div>
            <div className={s.panelRow}>
              <span className={s.panelLabel}>plano</span>
              <span className={s.panelValue}>{planLabel(user)}</span>
            </div>

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
                <span className={s.panelLabel}>catálogo</span>
                <span className={publico ? s.checkOn : s.checkOff}>
                  {publico ? '[x]' : '[ ]'}
                </span>
                <span className={s.panelValue}>
                  incluir o catálogo público (audius) na lista
                </span>
              </button>
            )}
          </div>

          {/* O rótulo não é enfeite: é o que diz que nada abaixo dele viaja
              junto com a conta. */}
          <span className={o.contaSecao}># aparelho — vale só neste navegador</span>

          <div className={s.panel}>
            <button
              type="button"
              className={`${s.panelRow} ${s.panelButton}`}
              aria-pressed={prefetch}
              onClick={() => libraryStore.getState().togglePrefetch()}
            >
              <span className={s.panelLabel}>buffer</span>
              <span className={prefetch ? s.checkOn : s.checkOff}>{prefetch ? '[x]' : '[ ]'}</span>
              <span className={s.panelValue}>pré-carregar a próxima faixa no aparelho</span>
            </button>

            <div className={s.panelRow}>
              <span className={s.panelLabel}>offline</span>
              <span className={s.panelValue}>
                {count} {count === 1 ? 'faixa' : 'faixas'} ·{' '}
                {fmtMB(offlineBytes({ cached, sizes }))}
              </span>
              {count > 0 && (
                <span className={o.contaLimpar}>
                  {/* Dois toques, e não um `confirm()`: apagar não dá para
                      desfazer, e a caixa nativa do navegador destoaria de
                      tudo aqui. */}
                  {confirmando ? (
                    <>
                      <span className={o.contaConfirma}>apagar {count}?</span>
                      <button
                        type="button"
                        className={s.logout}
                        onClick={() => {
                          setConfirmando(false);
                          void controller.clearDownloads();
                        }}
                      >
                        [sim]
                      </button>
                      <button type="button" className={s.link} onClick={() => setConfirmando(false)}>
                        [não]
                      </button>
                    </>
                  ) : (
                    <button type="button" className={s.link} onClick={() => setConfirmando(true)}>
                      [limpar downloads]
                    </button>
                  )}
                </span>
              )}
            </div>

            <div className={s.panelRow}>
              <span className={s.panelLabel}>espaço</span>
              <span className={s.panelValue}>{storageLabel(espaco)}</span>
            </div>
          </div>

          {/* Sair não leva os downloads embora — e isso tem de estar escrito,
              porque o áudio do acervo é privado e fica no aparelho. As
              curtidas saíram desta frase quando viraram da conta: sair APAGA
              as deste navegador, e entrar de novo as traz de volta. */}
          {user && count > 0 && (
            <span className={o.contaSecao}>sair não apaga os downloads deste aparelho.</span>
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
