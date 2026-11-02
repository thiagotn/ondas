import { PlaylistsError } from '../ports/playlists.js';
import type { PlaylistsService } from '../ports/playlists.js';
import type { Playlist } from '../types.js';

/** Mesma origem da PWA — sem CORS, e o cookie vai sozinho. */
const ROTA = '/api/playlists';

interface Resposta {
  playlists?: unknown;
  error?: unknown;
}

/**
 * Faixa válida de uma lista de ids que atravessou rede e cache.
 *
 * Peneira defensiva como a do acervo e a das curtidas: um id que não é string
 * viraria uma chave `undefined` na tela, e o erro apareceria longe daqui.
 */
function ids(bruto: unknown): string[] {
  if (!Array.isArray(bruto)) return [];
  return bruto.filter((id): id is string => typeof id === 'string' && !!id);
}

function playlist(bruta: unknown): Playlist | null {
  if (!bruta || typeof bruta !== 'object') return null;
  const p = bruta as Record<string, unknown>;
  if (typeof p['id'] !== 'string' || !p['id']) return null;
  // Nome vazio não existe no servidor (`nomeValido` recusa), mas um fallback
  // aqui é mais barato que uma linha sem rótulo na tela.
  const nome = typeof p['nome'] === 'string' && p['nome'] ? p['nome'] : 'sem nome';
  return { id: p['id'], nome, itens: ids(p['itens']) };
}

/**
 * As playlists da conta, contra a nossa API.
 *
 * Não guarda espelho nenhum: quem guarda é o `libraryStore`, que já é a fonte
 * do render e já persiste — exatamente como o `HttpLikesService`.
 */
export class HttpPlaylistsService implements PlaylistsService {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    // Embrulhado em vez de `fetchImpl ?? globalThis.fetch`: `fetch` solto perde
    // o `this` do runtime e explode em alguns navegadores.
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async list(signal?: AbortSignal): Promise<Playlist[]> {
    return this.ler(await this.pedir(ROTA, signal ? { signal } : {}));
  }

  async criar(nome: string): Promise<Playlist[]> {
    return this.ler(await this.pedir(ROTA, this.comCorpo('POST', { nome })));
  }

  async renomear(id: string, nome: string): Promise<Playlist[]> {
    return this.ler(await this.pedir(`${ROTA}/${id}`, this.comCorpo('PATCH', { nome })));
  }

  async apagar(id: string): Promise<Playlist[]> {
    return this.ler(await this.pedir(`${ROTA}/${id}`, { method: 'DELETE' }));
  }

  async aplicar(
    id: string,
    mudanca: { add?: readonly string[]; remove?: readonly string[]; ordem?: readonly string[] },
  ): Promise<Playlist[]> {
    // Só os campos pedidos vão no corpo: o servidor lê com
    // `DisallowUnknownFields` e trata lista ausente como "não mexe", então
    // mandar `[]` nos outros dois seria dizer a mesma coisa com mais bytes.
    return this.ler(await this.pedir(`${ROTA}/${id}/itens`, this.comCorpo('PATCH', mudanca)));
  }

  private comCorpo(method: string, corpo: unknown): RequestInit {
    return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) };
  }

  private pedir(url: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(url, {
      credentials: 'same-origin',
      ...init,
      headers: { accept: 'application/json', ...init.headers },
    });
  }

  private async ler(res: Response): Promise<Playlist[]> {
    if (res.status === 401) throw new PlaylistsError('sessão expirada', true);
    if (!res.ok) {
      // A mensagem do servidor é em pt-BR e dita para ser lida (o nome em uso,
      // o teto estourado), então ela vai para a tela quando existe.
      const corpo = (await res.json().catch(() => ({}))) as Resposta;
      const msg = typeof corpo.error === 'string' && corpo.error ? corpo.error : null;
      throw new PlaylistsError(
        msg ?? `playlists responderam ${res.status}`,
        false,
        res.status === 409,
      );
    }
    const corpo = (await res.json()) as Resposta;
    if (!Array.isArray(corpo.playlists)) return [];
    return corpo.playlists.map(playlist).filter((p): p is Playlist => p !== null);
  }
}
