import { t } from '@ondas/core';
import { registerSW } from 'virtual:pwa-register';
import { playerStore, uiStore } from './stores';

/**
 * Quando o app troca de versão.
 *
 * O service worker novo fica ESPERANDO (ver `sw.ts`) e a hora de entrar é
 * decidida aqui. A regra é uma: **não recarregar com música tocando.**
 *
 * A recarga em si é necessária — o `cleanupOutdatedCaches()` apaga os chunks
 * do build velho, e a página que continuasse rodando pediria arquivo que não
 * existe mais. O problema era ela acontecer sozinha: com
 * `registerType: 'autoUpdate'` a biblioteca chamava `window.location.reload()`
 * assim que o SW novo ativava, e o `skipWaiting()` do install fazia isso cair
 * ~1s depois de abrir. Dois estragos: a abertura rodava duas vezes, e um
 * deploy no meio de uma faixa calava o player sem recado nenhum.
 */

/** Marca que a carga seguinte é continuação desta, e não um boot de verdade. */
const CHAVE = 'ondas:recarga-de-versao';

function marcar(): void {
  try {
    sessionStorage.setItem(CHAVE, '1');
  } catch {
    // Modo privado, cookies bloqueados: a abertura roda de novo, e só.
  }
}

/**
 * Lê e APAGA: a marca vale para uma carga só.
 *
 * Quem lê é a abertura. Trocar de versão não é um boot novo aos olhos de quem
 * está usando o app — é a mesma sessão continuando.
 */
export function recarregouParaAtualizar(): boolean {
  try {
    const tem = sessionStorage.getItem(CHAVE) !== null;
    sessionStorage.removeItem(CHAVE);
    return tem;
  } catch {
    return false;
  }
}

/** Registra o SW e assume o controle do momento da troca. Só em produção. */
export function iniciarAtualizacao(): void {
  const aplicar = registerSW({
    immediate: true,
    onNeedRefresh() {
      // Tocando: a música vale mais que a versão. O SW continua esperando, e o
      // workbox-window redispara este mesmo aviso no boot seguinte — ele
      // reconhece um SW que já estava à espera antes do registro
      // (`wasWaitingBeforeRegister`), e nessa hora nada está tocando.
      if (playerStore.getState().playing) {
        uiStore.getState().flash(t('toast.versaoNova'));
        return;
      }
      // A marca ANTES de mandar o `SKIP_WAITING`: quem recarrega é o listener
      // de `controlling` da biblioteca, e ele não avisa antes de recarregar.
      marcar();
      void aplicar();
    },
  });
}
