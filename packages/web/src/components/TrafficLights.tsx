import s from './shell.module.css';

/**
 * Os três pontos de janela, em vermelho/amarelo/verde.
 *
 * Moram só na tela de login, onde a barra de cima é mesmo uma janela falsa —
 * tem título ao centro (`ondas — login`) e nada para clicar. Saíram da casca
 * do app: ali a barra é de abas de verdade, e os pontos não abriam, fechavam
 * nem minimizavam coisa alguma.
 */
export function TrafficLights() {
  return (
    <span className={s.lights} aria-hidden="true">
      <span className={s.light} style={{ background: 'var(--ansi-1)' }} />
      <span className={s.light} style={{ background: 'var(--ansi-3)' }} />
      <span className={s.light} style={{ background: 'var(--ansi-2)' }} />
    </span>
  );
}
