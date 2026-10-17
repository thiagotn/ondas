import type { EnviadorDeBytes } from '@ondas/core';

/**
 * Grava o arquivo na URL assinada do R2, com progresso.
 *
 * `XMLHttpRequest` e não `fetch` por um motivo só: **fetch não reporta
 * progresso de upload**. A alternativa seria um `ReadableStream` no corpo, que
 * o Safari não implementa — e este app é usado no celular.
 *
 * O PUT vai direto para o bucket, fora da nossa origem, então depende do CORS
 * do R2 permitir `PUT` e o header `content-type` (ver storage.regrasCORS). Um
 * erro aqui aparece como status 0 com console limpo, que é o jeito do
 * navegador de dizer "CORS".
 */
export const enviarParaR2: EnviadorDeBytes<File> = (url, arquivo, aoProgredir, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('envio cancelado', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) aoProgredir(e.loaded);
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      // O corpo do R2 é XML e não ajuda o usuário; o status ajuda a depurar.
      reject(new Error(`o bucket recusou o envio (HTTP ${xhr.status})`));
    });
    xhr.addEventListener('error', () => {
      // Status 0 é o jeito do navegador de dizer CORS: ele recusa a resposta
      // e não conta o motivo ao script. A pista vai para o console, não para
      // a tela — quem precisa dela é quem administra o bucket.
      if (xhr.status === 0) {
        console.warn(
          '[ondas] o PUT no bucket falhou sem status: confira se o CORS do R2 permite PUT e o header content-type',
        );
      }
      reject(new Error('falha de rede ao enviar o arquivo'));
    });
    xhr.addEventListener('abort', () => reject(new DOMException('envio cancelado', 'AbortError')));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });

    xhr.send(arquivo);
  });
