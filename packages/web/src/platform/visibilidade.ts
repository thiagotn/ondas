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
