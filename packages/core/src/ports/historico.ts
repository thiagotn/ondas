/**
 * Erro ao falar do marcador ou do histórico com o servidor.
 *
 * `semSessao` separa o 401 do resto pelo mesmo motivo do `LikesError`: ele não
 * é falha, é o servidor dizendo que a sessão acabou.
 */
export class HistoricoError extends Error {
  constructor(
    message: string,
    readonly semSessao = false,
  ) {
    super(message);
    this.name = 'HistoricoError';
  }
}

/**
 * Onde a conta parou: a última faixa e o segundo dela.
 *
 * Guarda o ID, nunca o índice — a lista muda de um aparelho para o outro (e de
 * um login para o outro), e o índice sai de `indexOfTrack` na hora de armar.
 *
 * A fila NÃO está aqui, de propósito: ela é a lista que está na tela, e quem
 * retoma num outro aparelho continua pela lista que estiver na tela dele.
 */
export interface Marcador {
  trackId: string;
  /** Segundos. */
  pos: number;
  /** Duração em segundos, para a barra já desenhar antes de o áudio carregar. */
  dur: number;
  /**
   * `Date.now()` de quando o som estava nesta posição — o relógio de QUEM
   * OUVIU, não o de quando o pedido chegou ao servidor. É por ele que dois
   * aparelhos se entendem: a posição gravada sem rede há duas horas não vence a
   * que o outro gravou há dez minutos.
   */
  em: number;
}

/**
 * Uma linha do histórico: o id e um RETRATO da faixa.
 *
 * O retrato (título, artista, duração) é a diferença para as curtidas, que
 * guardam só o id. Curtida é filtro sobre o catálogo carregado; histórico não
 * pode ser, porque o trending gira e a faixa de ontem não está no catálogo de
 * hoje — a lista esvaziaria sozinha.
 */
export interface ItemDoHistorico {
  trackId: string;
  titulo: string;
  artista: string;
  /** Segundos, inteiro. */
  dur: number;
  /** `Date.now()` de quando a faixa contou como ouvida. */
  em: number;
}

/**
 * O marcador e o histórico da conta, no servidor.
 *
 * `gravarMarcador` devolve o marcador que FICOU, que pode não ser o que foi
 * mandado: o servidor ignora a escrita mais velha que a vigente. `registrar` e
 * `limpar` devolvem a coleção inteira, pelo contrato das curtidas.
 */
export interface HistoricoService {
  /** `null` = a conta nunca ouviu nada (ou a API ainda não conhece a rota). */
  marcador(signal?: AbortSignal): Promise<Marcador | null>;
  /**
   * `keepalive` é para a escrita feita com a página saindo de cena: sem ele o
   * navegador cancela o pedido junto com a aba.
   */
  gravarMarcador(m: Marcador, opts?: { keepalive?: boolean }): Promise<Marcador | null>;
  listar(signal?: AbortSignal): Promise<ItemDoHistorico[]>;
  registrar(itens: readonly ItemDoHistorico[]): Promise<ItemDoHistorico[]>;
  limpar(): Promise<ItemDoHistorico[]>;
}
