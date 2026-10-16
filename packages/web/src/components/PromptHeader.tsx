import type { PromptLine } from '@ondas/core';
import s from './shell.module.css';

/** `visitante@ondas ~/em-alta ❯ ondas trending --genero=tudo` + cursor piscando. */
export function PromptHeader({ line }: { line: PromptLine }) {
  return (
    <>
      <div className={s.prompt}>
        <span className={s.who}>{line.who}@ondas</span>
        <span className={s.cwd}>{line.cwd}</span>
        <span className={s.caret}>❯</span>
        <span>{line.cmd}</span>
        <span className={s.cursor} aria-hidden="true" />
      </div>
      <div className={s.comment}># {line.comment}</div>
    </>
  );
}
