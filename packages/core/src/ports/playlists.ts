import type { Playlist } from '../types.js';

/**
 * Erro ao falar de playlists com o servidor.
 *
 * `semSessao` separa o 401 do resto pelo mesmo motivo do `LikesError` e do
 * `AcervoError`: ele não é falha, é o servidor dizendo que a sessão acabou — e
 * o tratamento é outro (mandar para o login, não tentar de novo).
 *
 * `conflito` existe aqui e não lá: nome repetido é a única recusa desta API que
 * a pessoa pode consertar sozinha, digitando outro nome. Sem separá-la, a tela
 * diria "não foi possível" para algo que tem resposta.
 */
export class PlaylistsError extends Error {
  constructor(
    message: string,
    readonly semSessao = false,
    readonly conflito = false,
  ) {
    super(message);
    this.name = 'PlaylistsError';
  }
}

/**
 * As playlists da conta, no servidor.
 *
 * TODOS os métodos devolvem a coleção INTEIRA que ficou, e não o que mudou. É o
 * contrato do servidor (ver o pacote `playlists` da API) e é o que deixa quem
 * chama aplicar o resultado direto no store, sem uma segunda leitura capaz de
 * discordar da escrita.
 *
 * `aplicar` manda os três gestos de uma vez — `add`, `remove` e `ordem` —
 * porque é uma rota só do outro lado: adicionar as faixas marcadas, tirar as
 * marcadas de dentro da playlist, e reordenar mandando a lista como ela deve
 * ficar.
 */
export interface PlaylistsService {
  list(signal?: AbortSignal): Promise<Playlist[]>;
  criar(nome: string): Promise<Playlist[]>;
  renomear(id: string, nome: string): Promise<Playlist[]>;
  apagar(id: string): Promise<Playlist[]>;
  aplicar(
    id: string,
    mudanca: { add?: readonly string[]; remove?: readonly string[]; ordem?: readonly string[] },
  ): Promise<Playlist[]>;
}
