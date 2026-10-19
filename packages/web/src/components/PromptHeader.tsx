import type { PromptLine } from '@ondas/core';
import { useState } from 'react';
import { uiStore, useUi } from '../app/stores';
import { cmdInputRef } from '../hooks/cmdInputRef';
import { useAccountOverlay } from '../hooks/useAccountOverlay';
import { useComando } from '../hooks/useComando';
import s from './shell.module.css';

/** `visitante@ondas ~/em-alta ❯ ondas trending --genero=tudo` + cursor piscando. */
export function PromptHeader({ line }: { line: PromptLine }) {
  const { openAccount } = useAccountOverlay();
  const cmdOpen = useUi((st) => st.cmdOpen);

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
          title="Conta e aparelho (5)"
          onClick={openAccount}
        >
          {line.who}@ondas
        </button>
        <span className={s.cwd}>{line.cwd}</span>
        <span className={s.caret}>❯</span>
        {cmdOpen ? (
          <CommandLine />
        ) : (
          <>
            <span>{line.cmd}</span>
            <span className={s.cursor} aria-hidden="true" />
          </>
        )}
      </div>
      <div className={s.comment}># {line.comment}</div>
    </>
  );
}

/**
 * O prompt deixa de ser enfeite.
 *
 * Um `<input>` de verdade, e não teclas lidas do handler global, porque o
 * guarda `typing` do `useShortcuts` desliga todos os atalhos enquanto o foco
 * está num campo — senão digitar `:12` trocaria de aba no `1`. O `:` fica fora
 * do campo: quem digita vê `:08` e tem `08` para ler.
 */
function CommandLine() {
  const [texto, setTexto] = useState('');
  const comando = useComando();

  return (
    <span className={s.cmdLinha}>
      <span className={s.cmdDoisPontos}>:</span>
      <input
        ref={cmdInputRef}
        className={s.cmdInput}
        value={texto}
        aria-label="Ir para a faixa pelo número"
        placeholder="nº da faixa"
        inputMode="numeric"
        autoComplete="off"
        onChange={(e) => setTexto(e.target.value)}
        onBlur={() => uiStore.getState().setCmdOpen(false)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          comando(texto);
        }}
      />
    </span>
  );
}
