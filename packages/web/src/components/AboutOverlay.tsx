import { useSplash } from '../app/splash';
import { useAboutOverlay } from '../hooks/useAboutOverlay';
import { useWide } from '../hooks/useWide';
import o from './overlay.module.css';
import s from './shell.module.css';

/**
 * `ondas --about` — o que o ondas é, e de quem.
 *
 * A quarta janela de referência, no mesmo molde das outras três (`whoami`,
 * `--help`, `+list-themes`): a caixa e o rótulo saem dos mesmos seletores.
 *
 * A abertura é reexibida daqui porque o logo da barra de abas, que antes a
 * reexibia, é agora quem abre esta janela — o recurso continua a um clique de
 * distância, só mudou de porta.
 */
export function AboutOverlay() {
  const wide = useWide();
  const { closeAbout } = useAboutOverlay();
  const replay = useSplash((st) => st.replay);

  return (
    <div className={o.backdrop} onClick={closeAbout} role="presentation">
      <div
        className={o.sobre}
        role="dialog"
        aria-modal="true"
        aria-label="ondas --about"
        onClick={(e) => e.stopPropagation()}
      >
        <span className={o.label}>ondas --about</span>
        <button type="button" className={o.close} onClick={closeAbout}>
          {wide ? '[esc] fechar' : 'fechar'}
        </button>

        <div className={o.sobreCorpo}>
          {/* Decorativa, e por isso um span vazio: o desenho é uma máscara no
              CSS (a explicação de por que não é texto está lá), e o nome do
              produto já está no rótulo da janela e na frase abaixo. */}
          <span className={`${o.sobreArte} ${o.sobreGlint}`} aria-hidden="true" />

          <p className={o.sobreTexto}>
            ondas é um player de música com estética de terminal — a fita roda, a
            lista é a tela, e tudo se faz pelo teclado.
          </p>
          <p className={o.sobreTexto}>
            um dos side projects de @thiagotn, feitos para estudar IA.
          </p>

          <div className={s.panel}>
            <div className={s.panelRow}>
              <span className={s.panelLabel}>versão</span>
              <span className={s.panelValue}>{__APP_VERSION__}</span>
            </div>
            <div className={s.panelRow}>
              <span className={s.panelLabel}>feito com</span>
              <span className={s.panelValue}>react · typescript · vite</span>
            </div>
            <div className={s.panelRow}>
              <span className={s.panelLabel}>autor</span>
              <span className={s.panelValue}>@thiagotn</span>
              <a
                className={s.link}
                href="https://github.com/thiagotn"
                target="_blank"
                rel="noreferrer"
              >
                [github]
              </a>
            </div>
          </div>

          {/* Fecha ANTES de reexibir: o splash cobre a tela inteira, e a janela
              esquecida embaixo dele reapareceria no fim da abertura. */}
          <button
            type="button"
            className={s.link}
            onClick={() => {
              closeAbout();
              replay();
            }}
          >
            [rever abertura]
          </button>
        </div>
      </div>
    </div>
  );
}
