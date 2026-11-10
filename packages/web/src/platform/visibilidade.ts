/**
 * Quando a página volta para a frente da pessoa.
 *
 * O controller não toca em `window`/`document` em lugar nenhum — tudo passa
 * por um adaptador daqui. Este existe porque o player precisava de um segundo
 * momento para tentar de novo: a pendência nascia presa ao evento `online`,
 * que a página em segundo plano não recebe.
 */
export function aoVoltarParaATela(cb: () => void): () => void {
  const voltou = () => {
    if (document.visibilityState === 'visible') cb();
  };
  document.addEventListener('visibilitychange', voltou);
  // `pageshow` é o que sobra quando a página volta do bfcache, onde o
  // `visibilitychange` nem sempre chega. Disparo duplo não incomoda: quem
  // escuta limpa a pendência antes de agir.
  window.addEventListener('pageshow', voltou);
  return () => {
    document.removeEventListener('visibilitychange', voltou);
    window.removeEventListener('pageshow', voltou);
  };
}

/**
 * Quando a página sai da frente da pessoa — a aba foi para trás, o app foi
 * minimizado, a página está sendo descarregada.
 *
 * É a última chance de gravar o que só existe na memória. `visibilitychange`
 * para oculto é o evento que os navegadores garantem (inclusive no celular,
 * onde `beforeunload` e `unload` não são confiáveis); `pagehide` cobre a
 * navegação para fora e a entrada no bfcache. Disparo duplo não incomoda: quem
 * escuta só grava o que ainda estiver por gravar.
 */
export function aoSairDaTela(cb: () => void): () => void {
  const saiu = () => {
    if (document.visibilityState === 'hidden') cb();
  };
  document.addEventListener('visibilitychange', saiu);
  window.addEventListener('pagehide', cb);
  return () => {
    document.removeEventListener('visibilitychange', saiu);
    window.removeEventListener('pagehide', cb);
  };
}
