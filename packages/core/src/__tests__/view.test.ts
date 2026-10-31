import { describe, expect, it } from 'vitest';
import { demoTracks } from '../catalog/demo.js';
import {
  bufferShortLabel,
  bufferSourceLabel,
  defaultLibrarySegment,
  hiddenInSegment,
  showsPublicCatalog,
  emptyText,
  genreOptions,
  LIBRARY_SEGMENTS,
  librarySegmentSlug,
  parseLibrarySegment,
  promptLine,
  storageLabel,
  visibleTracks,
} from '../view.js';

const tracks = demoTracks();
const base = { tracks, q: '', genre: 'tudo', seg: 'liked' as const, liked: {}, cached: {} };

describe('defaultLibrarySegment', () => {
  it('com conta abre no acervo, que é o que a biblioteca da pessoa tem', () => {
    expect(defaultLibrarySegment({ name: 'thiago' })).toBe('acervo');
  });

  it('sem conta volta a `liked`: o chip do acervo nem é desenhado ali', () => {
    expect(defaultLibrarySegment(null)).toBe('liked');
  });
});

describe('showsPublicCatalog', () => {
  it('visitante vê sempre: é a única fonte que ele tem', () => {
    expect(showsPublicCatalog(null)).toBe(true);
  });

  it('com conta, quem decide é o campo da conta', () => {
    expect(showsPublicCatalog({ name: 'thiago', publico: true })).toBe(true);
    expect(showsPublicCatalog({ name: 'thiago', publico: false })).toBe(false);
  });

  it('espelho velho, sem o campo, significa MOSTRA e não desligado', () => {
    // É o caso real: `restore()` devolve o espelho do IndexedDB sem validar
    // quando não há rede, e um espelho gravado antes deste campo existir não o
    // tem. Lendo como `=== true`, o catálogo público desapareceria sozinho
    // justamente offline, onde não há como religar.
    expect(showsPublicCatalog({ name: 'thiago' })).toBe(true);
  });
});

describe('hiddenInSegment', () => {
  const marks = { liked: { demo0: true, saiu: true }, cached: { saiu: true } };
  const naLista = [tracks[0]!];

  it('conta o que o recorte guarda e a lista não mostra', () => {
    expect(naLista[0]!.id).toBe('demo0');
    expect(hiddenInSegment('liked', marks, naLista)).toBe(1);
    expect(hiddenInSegment('offline', marks, naLista)).toBe(1);
  });

  it('nada escondido quando a lista tem tudo', () => {
    expect(hiddenInSegment('liked', { liked: { demo0: true }, cached: {} }, naLista)).toBe(0);
  });

  it('o acervo não entra na conta: ele não depende de marca local', () => {
    expect(hiddenInSegment('acervo', marks, [])).toBe(0);
  });
});

describe('LIBRARY_SEGMENTS', () => {
  it('a ordem é a da tela, e o acervo fica no meio', () => {
    // Esta lista É a ordem dos chips (`LibraryRoute` só a mapeia). O acervo no
    // meio e não no fim porque ele é o padrão de quem tem conta, e o padrão no
    // canto direito faria a tela abrir com o chip mais distante marcado.
    expect([...LIBRARY_SEGMENTS]).toEqual(['liked', 'acervo', 'offline']);
  });
});

describe('parseLibrarySegment', () => {
  it('ida e volta pelos três recortes', () => {
    for (const seg of LIBRARY_SEGMENTS) {
      expect(parseLibrarySegment(librarySegmentSlug(seg), 'liked')).toBe(seg);
    }
  });

  it('o acervo é `archive` na URL, porque o path é inglês e o id não', () => {
    expect(librarySegmentSlug('acervo')).toBe('archive');
    expect(parseLibrarySegment('archive', 'liked')).toBe('acervo');
  });

  it('sem segmento é o padrão, que é o que `/library` significa', () => {
    for (const vazio of [undefined, '']) {
      expect(parseLibrarySegment(vazio, 'acervo')).toBe('acervo');
      expect(parseLibrarySegment(vazio, 'liked')).toBe('liked');
    }
  });

  it('o que vem errado na URL não atravessa para dentro do app', () => {
    // Sem a peneira, `promptLine` escreveria `ondas ls --lixo` e a lista
    // mostraria o recorte errado — a URL mandando no prompt. `acervo` entra na
    // lista por ser a palavra velha: ela deixou de existir, não redireciona.
    // O padrão aqui é `liked` de propósito: com `acervo` a palavra velha
    // acertaria o recorte por coincidência e o teste não provaria nada.
    for (const lixo of ['lixo', 'LIKED', '../', 'liked ', 'archive/x', 'acervo']) {
      expect(parseLibrarySegment(lixo, 'liked')).toBe('liked');
    }
  });
});

describe('genreOptions', () => {
  it('começa em tudo e limita a 8 gêneros', () => {
    const opts = genreOptions(tracks);
    expect(opts[0]).toBe('tudo');
    expect(opts.length).toBeLessThanOrEqual(9);
    expect(new Set(opts).size).toBe(opts.length);
  });
});

describe('visibleTracks', () => {
  it('home filtra por gênero', () => {
    expect(visibleTracks({ ...base, tab: 'home' })).toHaveLength(12);
    expect(visibleTracks({ ...base, tab: 'home', genre: 'lofi' }).map((t) => t.title)).toEqual([
      'Fio de Cobre',
      'Calçada Fria',
    ]);
  });

  it('busca vazia mostra 8 sugestões', () => {
    expect(visibleTracks({ ...base, tab: 'search' })).toHaveLength(8);
  });

  it('busca casa título, artista e gênero, ignorando caixa e # inicial', () => {
    expect(visibleTracks({ ...base, tab: 'search', q: 'bruma' })).toHaveLength(2);
    expect(visibleTracks({ ...base, tab: 'search', q: '#TECHNO' })).toHaveLength(2);
    expect(visibleTracks({ ...base, tab: 'search', q: 'maré' })).toHaveLength(1);
    expect(visibleTracks({ ...base, tab: 'search', q: 'xyz' })).toHaveLength(0);
  });

  it('biblioteca filtra pelo segmento', () => {
    const liked = { demo1: true };
    const cached = { demo2: true, demo5: true };
    expect(visibleTracks({ ...base, tab: 'library', seg: 'liked', liked, cached })).toHaveLength(1);
    expect(visibleTracks({ ...base, tab: 'library', seg: 'offline', liked, cached })).toHaveLength(2);
  });

  it('o segmento acervo vai pela procedência, não pelo que o aparelho marcou', () => {
    const proprias = tracks.slice(0, 2).map((t) => ({ ...t, source: 'acervo' as const }));
    const misturadas = [...proprias, ...tracks.slice(2)];
    const so = visibleTracks({ ...base, tracks: misturadas, tab: 'library', seg: 'acervo' });
    expect(so).toHaveLength(2);
    expect(so.every((t) => t.source === 'acervo')).toBe(true);
    // Nada de curtida nem de offline: as duas marcas estão vazias aqui.
    expect(visibleTracks({ ...base, tracks: misturadas, tab: 'library', seg: 'liked' })).toHaveLength(0);
  });
});

describe('promptLine', () => {
  it('home mostra o comando trending e a fonte', () => {
    expect(
      promptLine({
        tab: 'home',
        who: 'visitante',
        genre: 'techno',
        q: '',
        seg: 'liked',
        count: 4,
        source: 'audius api (ao vivo)',
      }),
    ).toEqual({
      who: 'visitante',
      cwd: '~/em-alta',
      cmd: 'ondas trending --genero=techno',
      comment: '4 faixas · fonte: audius api (ao vivo)',
    });
  });

  it('com só o acervo, a contagem não é dita duas vezes', () => {
    // `13 faixas · fonte: só o acervo (13)` seria a mesma conta repetida: o
    // `+ acervo (N)` existe para dizer quanto da lista MISTURADA é próprio.
    expect(
      promptLine({
        tab: 'home',
        who: 'thiago',
        genre: 'tudo',
        q: '',
        seg: 'liked',
        count: 13,
        source: 'só o acervo',
        acervo: 13,
      }).comment,
    ).toBe('13 faixas · fonte: só o acervo');
  });

  it('avisa quando o que está na tela ainda é o dado anterior', () => {
    expect(
      promptLine({
        tab: 'home',
        who: 'visitante',
        genre: 'tudo',
        q: '',
        seg: 'liked',
        count: 24,
        source: 'audius api (ao vivo)',
        refreshing: true,
      }).comment,
    ).toBe('24 faixas · fonte: audius api (ao vivo) · atualizando');
  });

  it('home sem fonte ainda mostra reticências', () => {
    expect(
      promptLine({ tab: 'home', who: 'a', genre: 'tudo', q: '', seg: 'liked', count: 0, source: '' })
        .comment,
    ).toBe('0 faixas · fonte: …');
  });

  it('busca alterna entre sugestões e contagem', () => {
    const args = { tab: 'search' as const, who: 'a', genre: 'tudo', seg: 'liked' as const, source: '' as const };
    expect(promptLine({ ...args, q: '', count: 8 })).toMatchObject({
      cwd: '~/buscar',
      cmd: 'ondas search ',
      comment: 'sugestões — digite para filtrar',
    });
    expect(promptLine({ ...args, q: 'bruma', count: 2 })).toMatchObject({
      cmd: 'ondas search "bruma"',
      comment: '2 resultados',
    });
  });

  it('biblioteca mostra o flag do segmento', () => {
    const args = { tab: 'library' as const, who: 'a', genre: 'tudo', q: '', source: '' as const, count: 3 };
    expect(promptLine({ ...args, seg: 'liked' }).cmd).toBe('ondas ls --curtidas');
    expect(promptLine({ ...args, seg: 'offline' }).cmd).toBe('ondas ls --offline');
    expect(promptLine({ ...args, seg: 'acervo' }).cmd).toBe('ondas ls --acervo');
    expect(promptLine({ ...args, seg: 'offline' }).comment).toBe('3 itens');
  });
});

describe('emptyText', () => {
  it('cobre cada aba e o estado da sessão', () => {
    expect(emptyText({ tab: 'home', seg: 'liked', q: '', loading: true, user: null })).toBe('');
    expect(emptyText({ tab: 'home', seg: 'liked', q: '', loading: false, user: null })).toBe(
      'nenhuma faixa.',
    );
    expect(emptyText({ tab: 'search', seg: 'liked', q: 'zzz', loading: false, user: null })).toBe(
      'grep: nenhum resultado para "zzz"',
    );
    expect(
      emptyText({ tab: 'library', seg: 'liked', q: '', loading: false, user: { name: 'a' } }),
    ).toBe('vazio — pressione [l] ou o coração para curtir.');
    // Sem conta os TRÊS recortes pedem login: a curtida virou da conta, e
    // mandar apertar [l] seria mandar apertar um botão que não liga.
    expect(emptyText({ tab: 'library', seg: 'liked', q: '', loading: false, user: null })).toBe(
      'curtidas exigem login.',
    );
    expect(
      emptyText({ tab: 'library', seg: 'offline', q: '', loading: false, user: { name: 'a' } }),
    ).toBe('vazio — baixe faixas [d] ou ative o buffer para ouvir sem rede.');
    expect(emptyText({ tab: 'library', seg: 'offline', q: '', loading: false, user: null })).toBe(
      'downloads offline exigem login.',
    );
    expect(
      emptyText({ tab: 'library', seg: 'acervo', q: '', loading: false, user: { name: 'a' } }),
    ).toBe('vazio — envie um arquivo com [+ arquivo].');
    expect(emptyText({ tab: 'library', seg: 'acervo', q: '', loading: false, user: null })).toBe(
      'o acervo exige login.',
    );
  });
});

describe('emptyText com o catálogo público desligado', () => {
  const base = { q: '', loading: false, user: { name: 'a', publico: false }, publicOff: true };

  it('em-alta vazia diz que é o acervo que está vazio, não "nenhuma faixa"', () => {
    // A frase genérica mandaria procurar o que não existe. Esta diz o caminho.
    expect(emptyText({ ...base, tab: 'home', seg: 'liked' })).toBe(
      'o acervo está vazio — envie um arquivo em ~/biblioteca.',
    );
  });

  it('recorte com download escondido não mente "vazio — baixe faixas"', () => {
    // `ondas whoami`, a um overlay de distância, continua dizendo "7 faixas ·
    // 54 MB": ele conta o estado do aparelho, não o catálogo. A lista vazia
    // tem de explicar a diferença em vez de contradizê-la.
    expect(emptyText({ ...base, tab: 'library', seg: 'offline', hidden: 7 })).toBe(
      '7 faixas aqui vêm do catálogo público, que está desligado — religue em [ondas whoami].',
    );
    expect(emptyText({ ...base, tab: 'library', seg: 'liked', hidden: 1 })).toBe(
      '1 faixa aqui vem do catálogo público, que está desligado — religue em [ondas whoami].',
    );
  });

  it('sem nada escondido, o texto de sempre volta', () => {
    expect(emptyText({ ...base, tab: 'library', seg: 'offline', hidden: 0 })).toBe(
      'vazio — baixe faixas [d] ou ative o buffer para ouvir sem rede.',
    );
    // E o acervo vazio continua falando de envio, que é o que o alimenta.
    expect(emptyText({ ...base, tab: 'library', seg: 'acervo' })).toBe(
      'vazio — envie um arquivo com [+ arquivo].',
    );
  });
});

describe('rótulos de buffer', () => {
  it('fonte: local, baixando ou em stream', () => {
    expect(bufferSourceLabel({ cached: true, downloading: null, hasStream: true, ahead: 0 })).toBe(
      'arquivo local — toca sem rede',
    );
    expect(bufferSourceLabel({ cached: false, downloading: 0.42, hasStream: true, ahead: 0 })).toBe(
      'baixando 42% → disponível offline',
    );
    expect(bufferSourceLabel({ cached: false, downloading: null, hasStream: true, ahead: 95 })).toBe(
      'stream · 1:35 em buffer à frente',
    );
    expect(bufferSourceLabel({ cached: false, downloading: null, hasStream: false, ahead: 40 })).toBe(
      'prévia · 0:40 em buffer à frente',
    );
  });

  it('buf: da status line', () => {
    expect(bufferShortLabel(true, 99)).toBe('buf: local');
    expect(bufferShortLabel(false, 72)).toBe('buf: +1:12');
  });
});

describe('storageLabel', () => {
  it('diz quanto ainda cabe, que é o número com que se decide', () => {
    expect(storageLabel({ bytes: 1.2 * 1073741824, quota: 4.2 * 1073741824 })).toBe(
      '3.0 GB livres de 4.2 GB',
    );
  });

  it('não inventa limite quando o navegador não informa', () => {
    expect(storageLabel({ bytes: 213.3 * 1048576 })).toBe(
      '213.3 MB usados · o navegador não informa o limite',
    );
  });

  it('não mostra espaço negativo quando o uso passa da cota', () => {
    // Acontece: a estimativa inclui outros armazenamentos da origem e pode
    // chegar rente ao teto.
    expect(storageLabel({ bytes: 5e9, quota: 4e9 })).toBe('0.0 MB livres de 3.7 GB');
  });

  it('enquanto não mediu, diz que está medindo', () => {
    expect(storageLabel(null)).toBe('calculando…');
  });
});
