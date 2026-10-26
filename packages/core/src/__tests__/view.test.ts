import { describe, expect, it } from 'vitest';
import { demoTracks } from '../catalog/demo.js';
import {
  bufferShortLabel,
  bufferSourceLabel,
  emptyText,
  genreOptions,
  promptLine,
  storageLabel,
  visibleTracks,
} from '../view.js';

const tracks = demoTracks();
const base = { tracks, q: '', genre: 'tudo', seg: 'liked' as const, liked: {}, cached: {} };

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
    expect(emptyText({ tab: 'library', seg: 'liked', q: '', loading: false, user: null })).toBe(
      'vazio — pressione [l] ou o coração para curtir.',
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
