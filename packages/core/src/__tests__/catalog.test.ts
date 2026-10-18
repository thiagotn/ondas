import { describe, expect, it, vi } from 'vitest';
import { AudiusCatalogClient } from '../catalog/audius.js';
import { demoTracks } from '../catalog/demo.js';
import {
  CATALOG_CACHE_MAX_AGE_MS,
  comFaixasAvulsas,
  loadCatalog,
  MAX_AVULSAS,
} from '../catalog/resolve.js';
import type { Catalog, Track } from '../types.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const AUDIUS_TRACK = {
  id: 'abc12',
  title: 'Concreto Molhado',
  genre: 'Drum & Bass',
  duration: 356,
  user: { name: 'Turbo Vício' },
  artwork: { '150x150': 'p.jpg', '480x480': 'g.jpg' },
};

describe('AudiusCatalogClient', () => {
  it('descobre o host e mapeia o trending', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u === 'https://api.audius.co') return json({ data: ['https://dn1.audius'] });
      expect(u).toContain('https://dn1.audius/v1/tracks/trending');
      expect(u).toContain('limit=24');
      return json({ data: [AUDIUS_TRACK] });
    });
    const client = new AudiusCatalogClient(fetchMock as unknown as typeof fetch);
    const tracks = await client.trending();
    expect(tracks).toEqual([
      {
        id: 'abc12',
        title: 'Concreto Molhado',
        artist: 'Turbo Vício',
        genre: 'drumbass',
        dur: 356,
        art: 'g.jpg',
        artThumb: 'p.jpg',
        stream: 'https://dn1.audius/v1/tracks/abc12/stream?app_name=ONDAS',
        // Explícito mesmo quando falso: sem o boolean o `access.ts` cairia no
        // heurístico posicional e a mesma faixa teria acesso diferente
        // conforme a posição na lista.
        premium: false,
      },
    ]);
    expect(client.streamUrl('abc12')).toContain('/v1/tracks/abc12/stream');
  });

  it('descarta faixas não tocáveis e preenche artista ausente', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url) === 'https://api.audius.co'
        ? json({ data: ['https://dn1.audius'] })
        : json({
            data: [
              { ...AUDIUS_TRACK, id: 'x1', is_streamable: false },
              { id: 'x2', title: 'Sem Artista', artwork: {} },
            ],
          }),
    );
    const tracks = await new AudiusCatalogClient(fetchMock as unknown as typeof fetch).trending();
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.artist).toBe('—');
    expect(tracks[0]!.genre).toBe('outros');
    expect(tracks[0]!.art).toBe('');
    expect(tracks[0]!.dur).toBe(0);
  });

  it('usa o fetch global sem perder o binding quando nenhum é injetado', async () => {
    // Regressão: guardar `fetch` nu como valor padrão quebra no navegador
    // ("Illegal invocation"), porque ele exige o objeto global como `this`.
    const original = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = function (this: unknown, url: string | URL | Request) {
      if (this !== globalThis && this !== undefined) throw new TypeError('Illegal invocation');
      calls.push(String(url));
      return Promise.resolve(
        String(url) === 'https://api.audius.co'
          ? json({ data: ['https://dn1.audius'] })
          : json({ data: [AUDIUS_TRACK] }),
      );
    } as unknown as typeof fetch;
    try {
      const tracks = await new AudiusCatalogClient().trending({ limit: 5 });
      expect(tracks).toHaveLength(1);
      expect(calls[0]).toBe('https://api.audius.co');
      expect(calls[1]).toContain('limit=5');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('erra quando a descoberta não devolve host', async () => {
    const fetchMock = vi.fn(async () => json({ data: [] }));
    await expect(
      new AudiusCatalogClient(fetchMock as unknown as typeof fetch).trending(),
    ).rejects.toThrow(/nenhum host/);
  });
});

describe('AudiusCatalogClient.track — a faixa de um deeplink', () => {
  const comHost = (resposta: (u: string) => Response) =>
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u === 'https://api.audius.co') return json({ data: ['https://dn1.audius'] });
      return resposta(u);
    });

  it('busca pelo id e devolve EXATAMENTE o que o trending devolveria', async () => {
    const fetchMock = comHost((u) => {
      if (u.includes('/v1/tracks/trending')) return json({ data: [AUDIUS_TRACK] });
      expect(u).toBe('https://dn1.audius/v1/tracks/abc12?app_name=ONDAS');
      return json({ data: AUDIUS_TRACK });
    });
    const client = new AudiusCatalogClient(fetchMock as unknown as typeof fetch);

    // Mesma carga pelos dois caminhos: é o que prova que o mapeador é um só —
    // a faixa aberta por link não pode aparecer diferente da mesma faixa na
    // lista.
    const [daLista] = await client.trending();
    const porId = await client.track('abc12');
    expect(porId).toEqual(daLista);
  });

  it('reusa o host já sorteado em vez de redescobrir', async () => {
    const fetchMock = comHost(() => json({ data: AUDIUS_TRACK }));
    const client = new AudiusCatalogClient(fetchMock as unknown as typeof fetch);
    await client.track('abc12');
    await client.track('abc12');
    const descobertas = fetchMock.mock.calls.filter(([u]) => String(u) === 'https://api.audius.co');
    expect(descobertas).toHaveLength(1);
  });

  it('id que não existe é null, não erro', async () => {
    const fetchMock = comHost(() => new Response('', { status: 404 }));
    const client = new AudiusCatalogClient(fetchMock as unknown as typeof fetch);
    await expect(client.track('sumiu')).resolves.toBeNull();
  });

  it('faixa não tocável é null — link não pode abrir player mudo', async () => {
    for (const campo of [{ is_streamable: false }, { is_available: false }]) {
      const fetchMock = comHost(() => json({ data: { ...AUDIUS_TRACK, ...campo } }));
      const client = new AudiusCatalogClient(fetchMock as unknown as typeof fetch);
      await expect(client.track('abc12')).resolves.toBeNull();
    }
  });

  it('falha de rede continua sendo erro, para distinguir de "não existe"', async () => {
    const fetchMock = comHost(() => new Response('', { status: 500 }));
    const client = new AudiusCatalogClient(fetchMock as unknown as typeof fetch);
    await expect(client.track('abc12')).rejects.toThrow(/500/);
  });

  it('o id vai escapado na URL', async () => {
    const fetchMock = comHost((u) => {
      expect(u).toContain('/v1/tracks/a%2Fb%3Fc');
      return new Response('', { status: 404 });
    });
    const client = new AudiusCatalogClient(fetchMock as unknown as typeof fetch);
    await client.track('a/b?c');
  });

  it('`premium` sai do gating da faixa, não da posição na lista', async () => {
    const gated = comHost(() => json({ data: { ...AUDIUS_TRACK, is_stream_gated: true } }));
    const livre = comHost(() => json({ data: AUDIUS_TRACK }));
    const a = new AudiusCatalogClient(gated as unknown as typeof fetch);
    const b = new AudiusCatalogClient(livre as unknown as typeof fetch);
    expect((await a.track('abc12'))?.premium).toBe(true);
    expect((await b.track('abc12'))?.premium).toBe(false);
  });
});

describe('comFaixasAvulsas', () => {
  const faixa = (id: string): Track => ({
    id,
    title: id,
    artist: 'a',
    genre: 'g',
    dur: 1,
    art: '',
    stream: 's',
  });
  const catalogo: Catalog = {
    tracks: [faixa('a'), faixa('b')],
    source: 'catálogo demo',
    acervo: 1,
  };

  it('entra no FIM, para não reembaralhar os índices de quem já estava', () => {
    const saida = comFaixasAvulsas(catalogo, [faixa('z')]);
    expect(saida!.tracks.map((t) => t.id)).toEqual(['a', 'b', 'z']);
  });

  it('não duplica faixa que já está na lista', () => {
    expect(comFaixasAvulsas(catalogo, [faixa('a')])).toBe(catalogo);
  });

  it('preserva a contagem do acervo e a fonte', () => {
    const saida = comFaixasAvulsas(catalogo, [faixa('z')])!;
    expect(saida.acervo).toBe(1);
    expect(saida.source).toBe('catálogo demo');
  });

  it('respeita o teto', () => {
    const muitas = Array.from({ length: MAX_AVULSAS + 5 }, (_, i) => faixa('n' + i));
    expect(comFaixasAvulsas(catalogo, muitas)!.tracks).toHaveLength(2 + MAX_AVULSAS);
  });

  it('catálogo ausente continua ausente', () => {
    expect(comFaixasAvulsas(undefined, [faixa('z')])).toBeUndefined();
  });

  it('sem avulsas devolve o mesmo objeto', () => {
    expect(comFaixasAvulsas(catalogo, [])).toBe(catalogo);
  });
});

describe('loadCatalog', () => {
  const remoteOk = { trending: async (): Promise<Track[]> => demoTracks().slice(0, 2) };
  const remoteFail = {
    trending: async (): Promise<Track[]> => {
      throw new Error('sem rede');
    },
  };

  it('nível 1: api ao vivo, e grava o cache', async () => {
    const writeCache = vi.fn(async () => {});
    const got = await loadCatalog({ remote: remoteOk, readCache: async () => undefined, writeCache });
    expect(got.source).toBe('audius api (ao vivo)');
    expect(got.tracks).toHaveLength(2);
    expect(writeCache).toHaveBeenCalledWith(got.tracks);
  });

  it('nível 2: metadados em cache local quando a api falha', async () => {
    const cached = demoTracks().slice(0, 3);
    const got = await loadCatalog({
      remote: remoteFail,
      readCache: async () => ({ tracks: cached, savedAt: Date.now() }),
      writeCache: async () => {},
    });
    expect(got.source).toBe('metadados em cache local');
    expect(got.tracks).toEqual(cached);
  });

  it('cache vencido cai para o demo em vez de mostrar capas mortas', async () => {
    const agora = 1_700_000_000_000;
    const base = {
      remote: remoteFail,
      readCache: async () => ({ tracks: demoTracks().slice(0, 3), savedAt: agora - CATALOG_CACHE_MAX_AGE_MS - 1 }),
      writeCache: async () => {},
      now: () => agora,
    };
    expect((await loadCatalog(base)).source).toBe('catálogo demo — api inacessível');

    // No limite da validade ainda vale.
    const noLimite = {
      ...base,
      readCache: async () => ({ tracks: demoTracks().slice(0, 3), savedAt: agora - CATALOG_CACHE_MAX_AGE_MS }),
    };
    expect((await loadCatalog(noLimite)).source).toBe('metadados em cache local');
  });

  it('nível 3: catálogo demo quando não há api nem cache', async () => {
    const onError = vi.fn();
    const got = await loadCatalog({
      remote: remoteFail,
      readCache: async () => undefined,
      writeCache: async () => {},
      onError,
    });
    expect(got.source).toBe('catálogo demo — api inacessível');
    expect(got.tracks).toHaveLength(12);
    expect(onError).toHaveBeenCalled();
  });

  it('catálogo vazio da api conta como falha', async () => {
    const got = await loadCatalog({
      remote: { trending: async () => [] },
      readCache: async () => undefined,
      writeCache: async () => {},
    });
    expect(got.source).toBe('catálogo demo — api inacessível');
  });

  it('forceDemo encurta a cadeia', async () => {
    const remote = { trending: vi.fn(async () => demoTracks()) };
    const got = await loadCatalog({
      remote,
      readCache: async () => undefined,
      writeCache: async () => {},
      forceDemo: true,
    });
    expect(got.source).toBe('catálogo demo');
    expect(remote.trending).not.toHaveBeenCalled();
  });

  it('cache ilegível não derruba o fallback', async () => {
    const got = await loadCatalog({
      remote: remoteFail,
      readCache: async () => {
        throw new Error('idb morto');
      },
      writeCache: async () => {},
    });
    expect(got.source).toBe('catálogo demo — api inacessível');
  });
});

describe('demoTracks', () => {
  it('são 12 faixas sem stream, com ids estáveis', () => {
    const t = demoTracks();
    expect(t).toHaveLength(12);
    expect(t.every((x) => x.stream === '' && x.art === '')).toBe(true);
    expect(t[0]!.id).toBe('demo0');
    expect(t[0]!.title).toBe('Maré Baixa');
  });
});
