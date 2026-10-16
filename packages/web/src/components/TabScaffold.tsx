import type { PromptLine } from '@ondas/core';
import type { ReactNode } from 'react';
import { useSession } from '../app/stores';
import { GuestNotice } from './GuestNotice';
import { PromptHeader } from './PromptHeader';

/** Cabeçalho comum das três abas: prompt, comentário e aviso de visitante. */
export function TabScaffold({ line, children }: { line: PromptLine; children: ReactNode }) {
  const user = useSession((s) => s.user);
  return (
    <>
      <PromptHeader line={line} />
      {!user && <GuestNotice />}
      {children}
    </>
  );
}
