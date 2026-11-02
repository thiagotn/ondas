import { describe, expect, it, vi } from 'vitest';
import { demoTracks } from '../catalog/demo.js';
import { moverNaOrdem } from '../playlists/ordem.js';
import { HttpPlaylistsService } from '../playlists/http.js';
import { PlaylistsError } from '../ports/playlists.js';
import { emptyText, hiddenInSegment, promptLine, visibleTracks } from '../view.js';

const tracks = demoTracks();
const base = {
  tracks,
  tab: 'library' as const,
  q: '',
  genre: 'tudo',
  seg: 'playlists' as const,
  liked: {},
  cached: {},
};

const resposta = (status: number, corpo?: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (corpo === undefined) throw new Error('sem json');
      return corpo;
    },
  }) as Response;

describe('moverNaOrdem', () => {
  it('troca com o vizinho, nas duas direções', () => {
    expect(moverNaOrdem(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(moverNaOrdem(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
  });

  // Dar a volta mandaria a faixa do topo para o fim da playlist por um toque a
  // mais, e desfazer isso é refazer a ordem à mão.
  it('não dá a volta nas bordas, e devolve a mesma referência', () => {
    const ids = ['a', 'b', 'c'];
    expect(moverNaOrdem(ids, 'a', -1)).toBe(ids);
    expect(moverNaOrdem(ids, 'c', 1)).toBe(ids);
  });

  it('id que não está na lista não mexe em nada', () => {
    const ids = ['a', 'b'];
    expect(moverNaOrdem(ids, 'fantasma', 1)).toBe(ids);
  });
});

describe('visibleTracks numa playlist', () => {
  // É o que separa uma playlist de uma pilha de curtidas: filtrar o catálogo
  // daria as mesmas faixas na ordem dele, não na dela.
  it('sai na ORDEM da playlist, e não na do catálogo', () => {
    const playlist = [tracks[3]!.id, tracks[0]!.id, tracks[1]!.id];
    expect(visibleTracks({ ...base, playlist }).map((t) => t.id)).toEqual(playlist);
  });

  it('id sem faixa carregada é descartado em silêncio', () => {
    const playlist = [tracks[1]!.id, 'faixa-que-saiu-do-trending', tracks[2]!.id];
    expect(visibleTracks({ ...base, playlist }).map((t) => t.id)).toEqual([
      tracks[1]!.id,
      tracks[2]!.id,
    ]);
  });

  it('sem playlist aberta a lista é vazia, não o catálogo inteiro', () => {
    expect(visibleTracks(base)).toEqual([]);
  });

  it('a mesma faixa duas vezes na lista não é inventada aqui', () => {
    // O servidor não deixa (a PK dos itens), e aqui a ordem recebida é
    // respeitada como vem — este teste trava o contrato de não deduplicar
    // calado, que esconderia o bug do outro lado.
    const playlist = [tracks[0]!.id, tracks[0]!.id];
    expect(visibleTracks({ ...base, playlist })).toHaveLength(2);
  });
});

describe('hiddenInSegment numa playlist', () => {
  it('conta os itens que não estão no catálogo', () => {
    const playlist = [tracks[0]!.id, 'saiu-1', 'saiu-2'];
    expect(hiddenInSegment('playlists', { liked: {}, cached: {}, playlist }, tracks)).toBe(2);
  });

  it('playlist inteira presente não esconde nada', () => {
    const playlist = [tracks[0]!.id, tracks[1]!.id];
    expect(hiddenInSegment('playlists', { liked: {}, cached: {}, playlist }, tracks)).toBe(0);
  });
});

describe('emptyText das playlists', () => {
  const comConta = { tab: 'library' as const, seg: 'playlists' as const, q: '', loading: false };

  it('sem conta é porta fechada, na forma das outras', () => {
    expect(emptyText({ ...comConta, user: null })).toBe('playlists exigem login.');
  });

  it('o índice vazio manda criar a primeira', () => {
    expect(emptyText({ ...comConta, user: { name: 'thiago' } })).toContain('nenhuma playlist');
  });

  // Desde que o botão saiu da tela (ele custava uma linha inteira acima da
  // lista), estas duas frases são o ÚNICO lugar que ensina o gesto a quem só
  // toca — a janela `?` não tem porta no toque. Elas têm de nomear os dois
  // caminhos.
  it('a playlist aberta e vazia ensina o gesto e a tecla', () => {
    const texto = emptyText({ ...comConta, user: { name: 'thiago' }, playlistAberta: true });
    expect(texto).toContain('segure uma faixa');
    expect(texto).toContain('tecle v');
    expect(texto).toContain('[+ playlist]');
  });

  it('o índice vazio ensina o mesmo gesto', () => {
    const texto = emptyText({ ...comConta, user: { name: 'thiago' } });
    expect(texto).toContain('segure uma faixa');
    expect(texto).toContain('tecle v');
  });

  // O ramo que não existia: com o catálogo público LIGADO, a faixa pode faltar
  // porque saiu do trending — e aí a tela não pode dizer "vazio".
  it('diz que as faixas saíram do catálogo, mesmo com o catálogo público ligado', () => {
    const texto = emptyText({
      ...comConta,
      user: { name: 'thiago' },
      playlistAberta: true,
      publicOff: false,
      hidden: 3,
    });
    expect(texto).toContain('3 faixas desta playlist');
    expect(texto).toContain('~/em-alta');
  });

  // Com o catálogo desligado a frase de `publicOff` continua ganhando: ela é a
  // que tem conserto ("religue em [ondas whoami]").
  it('com o catálogo público desligado, a frase que tem conserto vence', () => {
    const texto = emptyText({
      ...comConta,
      user: { name: 'thiago' },
      playlistAberta: true,
      publicOff: true,
      hidden: 3,
    });
    expect(texto).toContain('ondas whoami');
  });
});

describe('promptLine das playlists', () => {
  const base = {
    tab: 'library' as const,
    who: 'thiago',
    genre: 'tudo',
    q: '',
    seg: 'playlists' as const,
    source: '' as const,
  };

  it('o índice conta playlists, não itens', () => {
    const linha = promptLine({ ...base, count: 3 });
    expect(linha.cmd).toBe('ondas ls --playlists');
    expect(linha.comment).toBe('3 playlists');
  });

  it('a playlist aberta leva o nome no comando', () => {
    const linha = promptLine({ ...base, count: 7, playlistNome: 'treino' });
    expect(linha.cmd).toBe('ondas ls --playlist="treino"');
    expect(linha.comment).toBe('7 itens');
  });

  it('e confessa quantas faixas não estão na lista', () => {
    const linha = promptLine({ ...base, count: 5, playlistNome: 'treino', fora: 2 });
    expect(linha.comment).toBe('5 itens · 2 fora da lista');
  });

  it('os outros recortes continuam dizendo `itens`', () => {
    const linha = promptLine({ ...base, seg: 'liked', count: 4 });
    expect(linha.cmd).toBe('ondas ls --curtidas');
    expect(linha.comment).toBe('4 itens');
  });
});

describe('HttpPlaylistsService', () => {
  it('lê a coleção e peneira o que não é playlist', async () => {
    const fetchImpl = vi.fn(async () =>
      resposta(200, {
        playlists: [
          { id: 'p1', nome: 'treino', itens: ['a', 'b'] },
          // Sem id: não dá para agir sobre ela, então não entra.
          { nome: 'sem id', itens: [] },
          // Itens que não são string viravam chave `undefined` na tela.
          { id: 'p2', nome: 'festa', itens: ['ok', 7, null] },
          'nem é objeto',
        ],
      }),
    );
    const svc = new HttpPlaylistsService(fetchImpl as unknown as typeof fetch);
    expect(await svc.list()).toEqual([
      { id: 'p1', nome: 'treino', itens: ['a', 'b'] },
      { id: 'p2', nome: 'festa', itens: ['ok'] },
    ]);
  });

  it('manda só os campos pedidos no corpo de `aplicar`', async () => {
    const fetchImpl = vi.fn(async () => resposta(200, { playlists: [] }));
    const svc = new HttpPlaylistsService(fetchImpl as unknown as typeof fetch);
    await svc.aplicar('p1', { add: ['a'] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/playlists/p1/itens');
    expect(init.method).toBe('PATCH');
    // Lista ausente é "não mexe" do outro lado; mandar `[]` nos outros dois
    // diria a mesma coisa com mais bytes.
    expect(JSON.parse(String(init.body))).toEqual({ add: ['a'] });
  });

  it('401 é sessão expirada, e não falha', async () => {
    const fetchImpl = vi.fn(async () => resposta(401, { error: 'sessão expirada' }));
    const svc = new HttpPlaylistsService(fetchImpl as unknown as typeof fetch);
    await expect(svc.list()).rejects.toMatchObject({ semSessao: true });
  });

  // Nome em uso é a única recusa que a pessoa conserta digitando outra coisa:
  // sem separá-la, a tela diria "não foi possível" para algo que tem resposta.
  it('409 vira conflito, com a frase do servidor', async () => {
    const fetchImpl = vi.fn(async () =>
      resposta(409, { error: 'já existe uma playlist com esse nome' }),
    );
    const svc = new HttpPlaylistsService(fetchImpl as unknown as typeof fetch);
    await expect(svc.criar('treino')).rejects.toMatchObject({
      conflito: true,
      message: 'já existe uma playlist com esse nome',
    });
  });

  it('erro sem corpo legível ainda vira PlaylistsError', async () => {
    const fetchImpl = vi.fn(async () => resposta(500));
    const svc = new HttpPlaylistsService(fetchImpl as unknown as typeof fetch);
    await expect(svc.list()).rejects.toBeInstanceOf(PlaylistsError);
  });
});
