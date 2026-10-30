import { describe, expect, it, vi } from 'vitest';
import { isLocked, isPremium } from '../access.js';
import { AcervoCatalogClient, AcervoError } from '../catalog/acervo.js';
import { loadCatalog } from '../catalog/resolve.js';
import type { CatalogClient } from '../catalog/client.js';
import type { Track } from '../types.js';

/** Uma resposta `fetch` de mentira, só com o que o cliente usa. */
const resposta = (status: number, corpo?: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => corpo,
  }) as Response;

const faixaDaAPI = {
  id: 'acervo:abb38f1b-2929-48fe-afbb-f376a479d196',
  title: 'Noite Fria',
  artist: 'Banda Teste',
  genre: 'acervo',
  dur: 231,
  art: '/api/acervo/abb38f1b/art',
  artThumb: '/api/acervo/abb38f1b/art?p=thumb',
  stream: '/api/acervo/abb38f1b/audio',
  premium: false,
};

describe('AcervoCatalogClient', () => {
  it('traz as faixas no formato do Track', async () => {
    const fetchImpl = vi.fn(async () => resposta(200, { tracks: [faixaDaAPI] }));
    const tracks = await new AcervoCatalogClient(fetchImpl as unknown as typeof fetch).tracks();

    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      id: faixaDaAPI.id,
      title: 'Noite Fria',
      dur: 231,
      stream: '/api/acervo/abb38f1b/audio',
      source: 'acervo',
    });
    // Sempre `false` explícito: `undefined` faria o heurístico do protótipo
    // marcar música própria como [pro].
    expect(tracks[0]!.premium).toBe(false);
  });

  it('manda o cookie e pede json', async () => {
    const fetchImpl = vi.fn(async (_rota: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      resposta(200, { tracks: [] }),
    );
    await new AcervoCatalogClient(fetchImpl as unknown as typeof fetch).tracks();

    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/acervo',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('401 é "sem sessão", que é o caso normal do visitante', async () => {
    const fetchImpl = vi.fn(async () => resposta(401, { error: 'sessão expirada' }));
    const cliente = new AcervoCatalogClient(fetchImpl as unknown as typeof fetch);

    await expect(cliente.tracks()).rejects.toBeInstanceOf(AcervoError);
    await expect(cliente.tracks()).rejects.toMatchObject({ semSessao: true });
  });

  it('503 é configuração faltando no servidor, não culpa de quem usa', async () => {
    const fetchImpl = vi.fn(async () => resposta(503, { error: 'acervo não configurado' }));
    const cliente = new AcervoCatalogClient(fetchImpl as unknown as typeof fetch);

    await expect(cliente.tracks()).rejects.toMatchObject({ semSessao: false });
  });

  it('descarta faixa sem id ou sem stream em vez de virar linha que não toca', async () => {
    const fetchImpl = vi.fn(async () =>
      resposta(200, {
        tracks: [
          faixaDaAPI,
          { ...faixaDaAPI, id: '' },
          { ...faixaDaAPI, stream: undefined },
          null,
          'não é objeto',
        ],
      }),
    );
    const tracks = await new AcervoCatalogClient(fetchImpl as unknown as typeof fetch).tracks();
    expect(tracks).toHaveLength(1);
  });

  it('preenche o que falta com padrão em vez de deixar vazio na tela', async () => {
    const fetchImpl = vi.fn(async () =>
      resposta(200, { tracks: [{ id: 'acervo:x', stream: '/api/acervo/x/audio' }] }),
    );
    const tracks = await new AcervoCatalogClient(fetchImpl as unknown as typeof fetch).tracks();
    expect(tracks[0]).toMatchObject({
      title: 'sem título',
      artist: 'acervo',
      genre: 'acervo',
      dur: 0,
      art: '',
    });
    expect(tracks[0]).not.toHaveProperty('artThumb');
  });

  it('resposta sem lista de faixas é erro', async () => {
    const fetchImpl = vi.fn(async () => resposta(200, { tracks: 'nada disso' }));
    const cliente = new AcervoCatalogClient(fetchImpl as unknown as typeof fetch);
    await expect(cliente.tracks()).rejects.toBeInstanceOf(AcervoError);
  });
});

// --- a costura das duas fontes --------------------------------------------

const publicas: Track[] = [
  { id: 'au1', title: 'Pública 1', artist: 'a', genre: 'techno', dur: 100, art: '', stream: 's1' },
  { id: 'au2', title: 'Pública 2', artist: 'b', genre: 'house', dur: 200, art: '', stream: 's2' },
];

const proprias: Track[] = [
  {
    id: 'acervo:1',
    title: 'Minha',
    artist: 'eu',
    genre: 'acervo',
    dur: 10,
    art: '',
    stream: '/api/acervo/1/audio',
    premium: false,
    source: 'acervo',
  },
];

const remoto = (tracks: Track[]): CatalogClient => ({ trending: async () => tracks });
const semCache = async () => undefined;
const nadaAGravar = async () => {};

describe('loadCatalog com as duas fontes', () => {
  it('sem acervo, nada muda — a cadeia de 3 níveis continua igual', async () => {
    const cat = await loadCatalog({
      remote: remoto(publicas),
      readCache: semCache,
      writeCache: nadaAGravar,
    });
    expect(cat.tracks).toEqual(publicas);
    expect(cat.source).toBe('audius api (ao vivo)');
    expect(cat.acervo).toBeUndefined();
  });

  it('as faixas próprias entram NA FRENTE e o total é contado', async () => {
    const cat = await loadCatalog({
      remote: remoto(publicas),
      readCache: semCache,
      writeCache: nadaAGravar,
      acervo: async () => proprias,
    });
    expect(cat.tracks.map((t) => t.id)).toEqual(['acervo:1', 'au1', 'au2']);
    expect(cat.acervo).toBe(1);
    // O rótulo da fonte pública segue dizendo a verdade sobre ela.
    expect(cat.source).toBe('audius api (ao vivo)');
  });

  it('acervo fora do ar não derruba o catálogo público', async () => {
    const onError = vi.fn();
    const cat = await loadCatalog({
      remote: remoto(publicas),
      readCache: semCache,
      writeCache: nadaAGravar,
      acervo: async () => {
        throw new AcervoError('acervo respondeu 500');
      },
      onError,
    });
    expect(cat.tracks).toEqual(publicas);
    expect(cat.acervo).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it('visitante (401) não polui o log: sem sessão não é falha', async () => {
    const onError = vi.fn();
    const cat = await loadCatalog({
      remote: remoto(publicas),
      readCache: semCache,
      writeCache: nadaAGravar,
      acervo: async () => {
        throw new AcervoError('sem sessão', true);
      },
      onError,
    });
    expect(cat.tracks).toEqual(publicas);
    expect(onError).not.toHaveBeenCalled();
  });

  it('catálogo público fora do ar não leva o acervo junto', async () => {
    const cat = await loadCatalog({
      remote: { trending: async () => { throw new Error('audius caiu'); } },
      readCache: semCache,
      writeCache: nadaAGravar,
      acervo: async () => proprias,
    });
    // Cai no demo para a parte pública, mas as faixas próprias continuam lá.
    expect(cat.source).toBe('catálogo demo — api inacessível');
    expect(cat.tracks[0]!.id).toBe('acervo:1');
    expect(cat.acervo).toBe(1);
  });

  it('forceDemo não impede o acervo — a flag é do catálogo público', async () => {
    const cat = await loadCatalog({
      remote: remoto(publicas),
      readCache: semCache,
      writeCache: nadaAGravar,
      forceDemo: true,
      acervo: async () => proprias,
    });
    expect(cat.source).toBe('catálogo demo');
    expect(cat.tracks[0]!.id).toBe('acervo:1');
  });

  it('soAcervo devolve só as faixas próprias, e a fonte diz isso', async () => {
    const cat = await loadCatalog({
      remote: remoto(publicas),
      readCache: semCache,
      writeCache: nadaAGravar,
      soAcervo: true,
      acervo: async () => proprias,
    });
    expect(cat.tracks.map((t) => t.id)).toEqual(['acervo:1']);
    expect(cat.source).toBe('só o acervo');
    expect(cat.acervo).toBe(1);
  });

  it('soAcervo não toca no catálogo público: nem rede, nem cache, nem demo', async () => {
    const trending = vi.fn(async () => publicas);
    const readCache = vi.fn(async () => undefined);
    const writeCache = vi.fn(async () => {});
    const cat = await loadCatalog({
      remote: { trending },
      readCache,
      writeCache,
      soAcervo: true,
      acervo: async () => proprias,
    });
    // Pedir o trending e jogar fora gastaria rede de graça; e gravar o nível 2
    // misturaria metadado público num cache que esta lista não usa.
    expect(trending).not.toHaveBeenCalled();
    expect(readCache).not.toHaveBeenCalled();
    expect(writeCache).not.toHaveBeenCalled();
    // E nenhuma faixa do demo entrou para "preencher" a lista.
    expect(cat.tracks).toEqual(proprias);
  });

  it('soAcervo vence forceDemo: quem pediu só o acervo não quer o demo no lugar', async () => {
    const cat = await loadCatalog({
      remote: remoto(publicas),
      readCache: semCache,
      writeCache: nadaAGravar,
      forceDemo: true,
      soAcervo: true,
      acervo: async () => proprias,
    });
    expect(cat.source).toBe('só o acervo');
    expect(cat.tracks).toEqual(proprias);
  });

  it('com soAcervo, acervo fora do ar REJEITA em vez de resolver vazio', async () => {
    // O inverso da regra das duas fontes, de propósito: resolvendo vazio, a
    // consulta sobrescreveria o cache persistido com lista vazia e o boot sem
    // rede viraria app em branco — com as faixas baixadas desaparecendo de
    // `--offline` e os bytes ainda no aparelho.
    await expect(
      loadCatalog({
        remote: remoto(publicas),
        readCache: semCache,
        writeCache: nadaAGravar,
        soAcervo: true,
        acervo: async () => {
          throw new Error('acervo fora do ar');
        },
      }),
    ).rejects.toThrow('acervo fora do ar');
  });

  it('busca as duas fontes em paralelo, não uma depois da outra', async () => {
    const ordem: string[] = [];
    const lenta = (nome: string, ms: number) => async () => {
      ordem.push(nome + ':começou');
      await new Promise((r) => setTimeout(r, ms));
      ordem.push(nome + ':terminou');
      return nome === 'acervo' ? proprias : publicas;
    };
    await loadCatalog({
      remote: { trending: lenta('publico', 20) },
      readCache: semCache,
      writeCache: nadaAGravar,
      acervo: lenta('acervo', 20),
    });
    // Se fossem sequenciais, o segundo só começaria depois do primeiro terminar.
    expect(ordem.slice(0, 2)).toEqual(['acervo:começou', 'publico:começou']);
  });
});

describe('o acervo não colide com o heurístico [pro] do protótipo', () => {
  it('faixa própria nunca é premium, mesmo na posição em que o heurístico dispara', async () => {
    // O heurístico marca cada 3ª faixa (índices 2, 5, 8...). Com as próprias na
    // frente, uma delas cai justamente num desses índices.
    const tresProprias: Track[] = [0, 1, 2].map((i) => ({
      ...proprias[0]!,
      id: `acervo:${i}`,
      title: `Minha ${i}`,
    }));
    const cat = await loadCatalog({
      remote: remoto(publicas),
      readCache: semCache,
      writeCache: nadaAGravar,
      acervo: async () => tresProprias,
    });

    const terceira = cat.tracks[2]!;
    expect(terceira.id).toBe('acervo:2');
    expect(isPremium(terceira, 2)).toBe(false);
    // E nem bloqueada para quem não tem sessão — embora esse caso não exista
    // na prática, porque sem sessão o acervo não entra na lista.
    expect(isLocked(terceira, 2, null)).toBe(false);
  });
});
