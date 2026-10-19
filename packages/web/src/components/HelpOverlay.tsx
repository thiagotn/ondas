import { atalhos, GRUPOS } from '@ondas/core';
import { useHelpOverlay } from '../hooks/useHelpOverlay';
import { useWide } from '../hooks/useWide';
import o from './overlay.module.css';

/**
 * `ondas --help` — a lista de atalhos.
 *
 * A tabela vem do core (`shortcuts.ts`), a mesma que alimenta a legenda do
 * rodapé: a janela não repete a lista, ela a mostra inteira. O grupo `dev` só
 * existe no build de dev, onde o atalho de simular queda de rede existe.
 */
export function HelpOverlay() {
  const wide = useWide();
  const { closeHelp } = useHelpOverlay();
  const lista = atalhos(import.meta.env.DEV);

  return (
    <div className={o.backdrop} onClick={closeHelp} role="presentation">
      <div
        className={o.atalhos}
        role="dialog"
        aria-modal="true"
        aria-label="ondas --help"
        onClick={(e) => e.stopPropagation()}
      >
        <span className={o.label}>ondas --help</span>
        <button type="button" className={o.close} onClick={closeHelp}>
          {wide ? '[esc] fechar' : 'fechar'}
        </button>

        <div className={o.atalhosCorpo}>
          {GRUPOS.map(([grupo, titulo]) => {
            const doGrupo = lista.filter((a) => a.grupo === grupo);
            if (!doGrupo.length) return null;
            return (
              <section key={grupo} className={o.atalhosSecao}>
                <span className={o.contaSecao}># {titulo}</span>
                <dl className={o.atalhosLista}>
                  {doGrupo.map((a) => (
                    <div key={a.tecla} className={o.atalhosLinha}>
                      <dt className={o.atalhosTecla}>{a.tecla}</dt>
                      <dd className={o.atalhosAcao}>{a.acao}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
