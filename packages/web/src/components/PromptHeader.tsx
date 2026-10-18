import type { PromptLine } from '@ondas/core';
import { useAccountOverlay } from '../hooks/useAccountOverlay';
import s from './shell.module.css';

/** `visitante@ondas ~/em-alta ❯ ondas trending --genero=tudo` + cursor piscando. */
export function PromptHeader({ line }: { line: PromptLine }) {
  const { openAccount } = useAccountOverlay();

  return (
    <>
      <div className={s.prompt}>
        {/* Segunda porta para `ondas whoami`, além do nome no rodapé. O
            painel de conta saiu da biblioteca, e sem isto quem procurasse
            "sair" não teria onde olhar no alto da tela. */}
        <button
          type="button"
          className={`${s.who} ${s.whoBotao}`}
          aria-label="Conta e aparelho"
          onClick={openAccount}
        >
          {line.who}@ondas
        </button>
        <span className={s.cwd}>{line.cwd}</span>
        <span className={s.caret}>❯</span>
        <span>{line.cmd}</span>
        <span className={s.cursor} aria-hidden="true" />
      </div>
      <div className={s.comment}># {line.comment}</div>
    </>
  );
}
