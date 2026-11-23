import type { PromptLine } from '@ondas/core';
import type { ReactNode } from 'react';
import { useSession } from '../app/stores';
import { GuestNotice } from './GuestNotice';
import { LinkNotice } from './LinkNotice';
import { PromptHeader } from './PromptHeader';

/** Cabeçalho comum das três abas: prompt, comentário e aviso de visitante. */
export function TabScaffold({ line, children }: { line: PromptLine; children: ReactNode }) {
  const user = useSession((s) => s.user);
  return (
    <>
      <PromptHeader line={line} />
      {!user && <GuestNotice />}
      {/* O link de música que o app achou (clipboard, colar, compartilhar).
          Aqui e não só na biblioteca: a pessoa volta para o app na aba em que
          estava. O componente some sozinho para quem não pode enviar. */}
      <LinkNotice />
      {children}
    </>
  );
}
