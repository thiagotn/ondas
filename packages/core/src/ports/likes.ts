/**
 * Erro ao falar de curtidas com o servidor.
 *
 * `semSessao` separa o 401 do resto pelo mesmo motivo do `AcervoError`: ele
 * não é falha, é o servidor dizendo que a sessão acabou — e o tratamento é
 * outro (mandar para o login, não tentar de novo).
 */
export class LikesError extends Error {
  constructor(
    message: string,
    readonly semSessao = false,
  ) {
    super(message);
    this.name = 'LikesError';
  }
}

/**
 * As curtidas da conta, no servidor.
 *
 * Só ids: nenhum metadado de faixa mora aqui, e `--curtidas` continua sendo um
 * filtro sobre o catálogo carregado.
 *
 * `apply` manda as duas listas de uma vez e devolve a coleção INTEIRA que
 * ficou — não o delta. É o que deixa quem chama aplicar o resultado direto no
 * store, sem uma segunda leitura que possa discordar da escrita. E é uma
 * chamada só para os três usos: o toque no coração, a fila acumulada sem rede
 * e a adoção das curtidas que já estavam no aparelho.
 */
export interface LikesService {
  list(signal?: AbortSignal): Promise<string[]>;
  apply(add: readonly string[], remove: readonly string[]): Promise<string[]>;
}
