import { trackUrl, type Track } from '@ondas/core';
import { uiStore } from '../app/stores';

/**
 * Manda o link da faixa para fora do app.
 *
 * Prefere a folha de compartilhamento do sistema, que no celular é o caminho
 * curto para o WhatsApp e o Telegram; sem ela, copia. Vive em `platform/`
 * porque é API de navegador — o endereço em si é montado pelo `core`.
 */
export async function compartilhar(track: Track): Promise<void> {
  const url = trackUrl(track, location.origin);
  const ui = uiStore.getState();
  // O link de faixa própria abre só para quem tem a conta. Avisar na hora de
  // copiar evita a pessoa descobrir isso pelo amigo que recebeu.
  const recado = track.source === 'acervo' ? 'link copiado — só você abre esta faixa' : 'link copiado';

  if (navigator.share) {
    try {
      await navigator.share({ title: track.title, text: `${track.title} — ${track.artist}`, url });
      return;
    } catch (err) {
      // Cancelar a folha de compartilhamento não é erro, e não merece recado.
      if (err instanceof Error && err.name === 'AbortError') return;
      // Qualquer outra falha cai no clipboard abaixo.
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    ui.flash(recado);
  } catch {
    // Sem clipboard (contexto não seguro, permissão negada) o link ainda
    // serve: mostrá-lo é melhor que um "não deu" sem saída.
    ui.flash(url);
  }
}
