import { acharLink, canUpload, type LinkAchado } from '@ondas/core';
import { create } from 'zustand';
import { sessionStore } from './stores';

/**
 * O link de música que o app achou e está OFERECENDO pôr no acervo.
 *
 * Três portas trazem um link até aqui, e todas param na oferta — nenhuma
 * enfileira nada sozinha:
 *
 *  - o clipboard, lido quando o app volta para a frente (só onde a permissão
 *    já foi dada);
 *  - colar (`Ctrl+V`) fora de um campo de texto, ou o `[+ link]` do painel de
 *    envio, que leem no gesto;
 *  - "Compartilhar para o Ondas", no Android (rota `/share`).
 *
 * O CLIPBOARD É DADO PRIVADO. As regras deste arquivo, todas por causa disso:
 *
 *  - o app nunca pede a permissão sozinho. Sem ela, a leitura automática
 *    simplesmente não acontece; quem a concede é a pessoa, tocando no
 *    `[+ link]`;
 *  - do texto lido só sobrevive a URL que `acharLink` reconheceu. O resto é
 *    descartado na hora e não vai para store, log nem servidor;
 *  - a URL só sai do aparelho quando a pessoa toca em `[adicionar ao acervo]`.
 */

export type OrigemDoLink = 'clipboard' | 'compartilhado';

interface LinkSugerido {
  link: LinkAchado | null;
  origem: OrigemDoLink;
  oferecer(link: LinkAchado, origem: OrigemDoLink): void;
  /** Tira o aviso da tela e lembra a URL, para não oferecê-la de novo. */
  resolver(): void;
}

/**
 * URLs que já foram oferecidas e respondidas (aceitas ou ignoradas) nesta
 * sessão do navegador. Sem isto, o mesmo link voltaria como aviso toda vez que
 * a aba ganhasse foco — o clipboard não muda só porque a pessoa disse "não".
 *
 * `sessionStorage` e não memória: recarregar a página não é resposta nova.
 */
const CHAVE_VISTOS = 'ondas-links-vistos';
const MAX_VISTOS = 40;

function vistos(): string[] {
  try {
    const bruto = JSON.parse(sessionStorage.getItem(CHAVE_VISTOS) ?? '[]') as unknown;
    return Array.isArray(bruto) ? bruto.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function marcarVisto(url: string): void {
  try {
    const lista = vistos().filter((u) => u !== url);
    lista.push(url);
    sessionStorage.setItem(CHAVE_VISTOS, JSON.stringify(lista.slice(-MAX_VISTOS)));
  } catch {
    // Sem storage (aba privada cheia, bloqueio): o pior caso é o aviso voltar.
  }
}

export const useLinkSugerido = create<LinkSugerido>((set, get) => ({
  link: null,
  origem: 'clipboard',
  oferecer: (link, origem) => set({ link, origem }),
  resolver: () => {
    const { link } = get();
    if (link) marcarVisto(link.url);
    set({ link: null });
  },
}));

const podeEnviar = () => canUpload(sessionStore.getState().user);

/**
 * Oferece o link de um texto, se houver um e ele ainda não foi respondido.
 * Devolve se ofereceu. `insistir` é para o gesto explícito (`[+ link]`, colar,
 * compartilhar): aí a pessoa PEDIU, e o "já vi este" não vale.
 */
export function oferecerDoTexto(
  texto: string | null | undefined,
  origem: OrigemDoLink,
  insistir = false,
): boolean {
  const link = acharLink(texto, location.host);
  if (!link) return false;
  if (!insistir && vistos().includes(link.url)) return false;
  useLinkSugerido.getState().oferecer(link, origem);
  return true;
}

/**
 * Lê o clipboard SÓ se a permissão já estiver concedida — nunca dispara o
 * pedido de permissão.
 *
 * Onde a pergunta "já tenho permissão?" não existe (Safari, Firefox), a
 * resposta é não ler: no iPhone cada leitura mostra um balão "Colar" e exige
 * toque, e um balão aparecendo sozinho ao abrir o app é exatamente o que não
 * se quer. Lá o caminho é o `[+ link]`.
 */
async function lerSePermitido(): Promise<string | null> {
  try {
    if (!navigator.clipboard?.readText || !navigator.permissions?.query) return null;
    const estado = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName });
    if (estado.state !== 'granted') return null;
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/**
 * Lê o clipboard NUM GESTO da pessoa (o toque no `[+ link]`). Aqui pedir a
 * permissão é legítimo — foi ela quem pediu a leitura. `null` quando o
 * navegador não deixa; a tela então abre um campo para colar.
 */
export async function lerNoGesto(): Promise<string | null> {
  try {
    if (!navigator.clipboard?.readText) return null;
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

async function aoVoltar(): Promise<void> {
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
  if (!podeEnviar() || useLinkSugerido.getState().link) return;
  oferecerDoTexto(await lerSePermitido(), 'clipboard');
}

function aoColar(e: ClipboardEvent): void {
  // Dentro de um campo, colar é colar: a busca e os formulários não são o
  // lugar de uma sugestão aparecer.
  const alvo = e.target as HTMLElement | null;
  const tag = alvo?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || alvo?.isContentEditable) return;
  if (!podeEnviar()) return;
  oferecerDoTexto(e.clipboardData?.getData('text/plain'), 'clipboard', true);
}

/**
 * Liga a detecção. Devolve como desligar. Chamada uma vez, pela casca do app.
 */
export function iniciarDeteccaoDeLink(): () => void {
  const voltar = () => void aoVoltar();
  document.addEventListener('visibilitychange', voltar);
  window.addEventListener('focus', voltar);
  document.addEventListener('paste', aoColar);
  // E uma vez na chegada: abrir o app com o link já copiado é o caso comum.
  voltar();
  return () => {
    document.removeEventListener('visibilitychange', voltar);
    window.removeEventListener('focus', voltar);
    document.removeEventListener('paste', aoColar);
  };
}
