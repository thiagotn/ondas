import { describe, expect, it, vi } from 'vitest';
import {
  MAX_NA_FILA,
  comAFila,
  enfileirar,
  faixasDoHistorico,
  leItens,
  retratoDe,
  semOQueSubiu,
} from '../historico/fila.js';
import { HttpHistoricoService } from '../historico/http.js';
import {
  ESPELHAR_A_CADA_MS,
  OBSERVADOR_VAZIO,
  SUBIR_A_CADA_MS,
  decidirRestauracao,
  leEspelho,
  leMarcador,
  limiarDeEscuta,
  maisNovo,
  marcadorDaAmostra,
  observar,
  posicaoDeRetomada,
} from '../historico/marcador.js';
import type { Amostra, Efeito, EstadoDoObservador } from '../historico/marcador.js';
import type { ItemDoHistorico, Marcador } from '../ports/historico.js';
import type { Track } from '../types.js';

const resposta = (status: number, corpo?: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (corpo === undefined) throw new Error('sem json');
      return corpo;
    },
  }) as Response;

/**
 * Um player de mentira para o observador: cada chamada é uma amostra, e o
 * relógio só anda quando o teste manda.
 */
function cena(dur = 200) {
  let estado: EstadoDoObservador = OBSERVADOR_VAZIO;
  let agora = 1_000_000;
  let amostra: Amostra = { curId: null, t: 0, dur, playing: false, waiting: false, agora };
  const ver = (parcial: Partial<Amostra>): Efeito[] => {
    amostra = { ...amostra, ...parcial, agora };
    const r = observar(estado, amostra);
    estado = r.estado;
    return r.efeitos;
  };
  return {
    ver,
    /** Toca `segundos` de música, em passos de 250 ms como o `timeupdate`. */
    tocar(segundos: number): Efeito[] {
      const todos: Efeito[] = [];
      for (let i = 0; i < segundos * 4; i += 1) {
        agora += 250;
        todos.push(...ver({ t: amostra.t + 0.25, playing: true, waiting: false }));
      }
      return todos;
    },
    passar(ms: number) {
      agora += ms;
    },
    get estado() {
      return estado;
    },
  };
}

describe('observar — quando o marcador é gravado', () => {
  it('player armado e parado não escreve nada, por mais que o tempo passe', () => {
    // A trava do conflito entre aparelhos: o celular aberto na mesa, com a faixa
    // de ontem armada, não pode gravar por cima do que o desktop está ouvindo.
    const c = cena();
    expect(c.ver({ curId: 'a', t: 42, playing: false })).toEqual([]);
    c.passar(60 * 60_000);
    expect(c.ver({ t: 42 })).toEqual([]);
    // Nem arrastar a barra: a posição nova vale quando o play vier.
    expect(c.ver({ t: 90 })).toEqual([]);
    expect(c.estado.tocou).toBe(false);
  });

  it('carregar uma faixa que nunca começa não escreve', () => {
    // `load` liga `playing` e `waiting` antes de qualquer som. Stream morto,
    // autoplay barrado: a faixa esteve "carregada" e ninguém a ouviu.
    const c = cena();
    expect(c.ver({ curId: 'a', t: 0, playing: true, waiting: true })).toEqual([]);
    c.passar(20_000);
    expect(c.ver({ waiting: true })).toEqual([]);
    expect(c.ver({ playing: false, waiting: false })).toEqual([]);
  });

  it('o primeiro som de uma faixa sobe na hora', () => {
    // É quando "estou ouvindo isto" vira verdade. Esperar o intervalo deixaria
    // o outro aparelho quinze segundos com a faixa anterior.
    const c = cena();
    c.ver({ curId: 'a', t: 0, playing: true, waiting: true });
    c.passar(250);
    expect(c.ver({ t: 0.25, waiting: false }).sort()).toEqual(['espelhar', 'subir']);
  });

  it('tocando, espelha a cada 5 s e sobe a cada 15 s', () => {
    const c = cena();
    c.ver({ curId: 'a', t: 0, playing: true });
    c.tocar(0.25); // o primeiro som, que sobe sozinho
    const efeitos = c.tocar(30);
    expect(efeitos.filter((e) => e === 'subir')).toHaveLength(30_000 / SUBIR_A_CADA_MS);
    // Cada subida também espelha, então o total é o do intervalo menor.
    expect(efeitos.filter((e) => e === 'espelhar')).toHaveLength(30_000 / ESPELHAR_A_CADA_MS);
  });

  it('pausar sobe na hora', () => {
    const c = cena();
    c.ver({ curId: 'a', t: 0, playing: true });
    c.tocar(3);
    expect(c.ver({ playing: false }).sort()).toEqual(['espelhar', 'subir']);
    // E pausado não escreve de novo.
    c.passar(60_000);
    expect(c.ver({ playing: false })).toEqual([]);
  });

  it('arrastar a barra numa faixa que já tocou sobe na hora, para a frente e para trás', () => {
    const c = cena();
    c.ver({ curId: 'a', t: 0, playing: true });
    c.tocar(3);
    expect(c.ver({ t: 120 })).toContain('subir');
    expect(c.ver({ t: 10 })).toContain('subir');
  });

  it('trocar de faixa não escreve até a nova tocar', () => {
    const c = cena();
    c.ver({ curId: 'a', t: 0, playing: true });
    c.tocar(3);
    expect(c.ver({ curId: 'b', t: 0, playing: true, waiting: true })).toEqual([]);
    expect(c.estado).toMatchObject({ curId: 'b', tocou: false, ouvido: 0, contou: false });
    c.passar(250);
    expect(c.ver({ t: 0.25, waiting: false })).toContain('subir');
  });

  it('sem faixa não há o que observar', () => {
    const c = cena();
    expect(c.ver({ curId: null, t: 0 })).toEqual([]);
    expect(marcadorDaAmostra({ curId: null, t: 0, dur: 0, playing: false, waiting: false, agora: 1 })).toBeNull();
  });

  it('o marcador sai da amostra com o relógio de quem ouviu', () => {
    expect(
      marcadorDaAmostra({ curId: 'a', t: 42.5, dur: 200, playing: true, waiting: false, agora: 777 }),
    ).toEqual({ trackId: 'a', pos: 42.5, dur: 200, em: 777 });
  });
});

describe('observar — quando a faixa entra no histórico', () => {
  it('conta uma vez, aos 30 s de escuta', () => {
    const c = cena(200);
    c.ver({ curId: 'a', t: 0, playing: true });
    expect(c.tocar(29)).not.toContain('contar');
    expect(c.tocar(2).filter((e) => e === 'contar')).toHaveLength(1);
    expect(c.tocar(60)).not.toContain('contar');
  });

  it('faixa curta conta na metade', () => {
    // Sem a metade, uma vinheta de vinte segundos nunca entraria no histórico.
    expect(limiarDeEscuta(20)).toBe(10);
    expect(limiarDeEscuta(200)).toBe(30);
    expect(limiarDeEscuta(0)).toBe(30);
    const c = cena(20);
    c.ver({ curId: 'a', t: 0, playing: true });
    expect(c.tocar(9)).not.toContain('contar');
    expect(c.tocar(2)).toContain('contar');
  });

  it('arrastar a barra não é ouvir', () => {
    // Pular para o minuto três não faz a faixa ter sido ouvida por três minutos.
    const c = cena(200);
    c.ver({ curId: 'a', t: 0, playing: true });
    c.tocar(5);
    expect(c.ver({ t: 180 })).not.toContain('contar');
    expect(c.estado.ouvido).toBeCloseTo(5);
    expect(c.tocar(10)).not.toContain('contar');
  });

  it('tempo em espera de buffer não soma', () => {
    const c = cena(200);
    c.ver({ curId: 'a', t: 0, playing: true });
    c.tocar(5);
    c.passar(250);
    c.ver({ t: 5.5, waiting: true });
    expect(c.estado.ouvido).toBeCloseTo(5);
  });

  it('a faixa seguinte conta de novo, do zero', () => {
    const c = cena(200);
    c.ver({ curId: 'a', t: 0, playing: true });
    expect(c.tocar(31)).toContain('contar');
    c.ver({ curId: 'b', t: 0, playing: true });
    expect(c.tocar(29)).not.toContain('contar');
    expect(c.tocar(2)).toContain('contar');
  });
});

describe('posicaoDeRetomada', () => {
  it('devolve a posição no meio da faixa', () => {
    expect(posicaoDeRetomada(42, 200)).toBe(42);
  });

  it('os primeiros segundos voltam ao começo', () => {
    expect(posicaoDeRetomada(4.9, 200)).toBe(0);
    expect(posicaoDeRetomada(5, 200)).toBe(5);
  });

  it('o fim da faixa volta ao começo', () => {
    // Fim da fila: armar a dois segundos do final faria o play tocar um
    // rabicho e parar.
    expect(posicaoDeRetomada(195, 200)).toBe(0);
    expect(posicaoDeRetomada(190, 200)).toBe(190);
  });

  it('sem duração conhecida, confia na posição', () => {
    expect(posicaoDeRetomada(42, 0)).toBe(42);
  });

  it('lixo vira zero', () => {
    expect(posicaoDeRetomada(Number.NaN, 200)).toBe(0);
    expect(posicaoDeRetomada(-3, 200)).toBe(0);
  });
});

describe('leMarcador e leEspelho', () => {
  const bom: Marcador = { trackId: 'a', pos: 42, dur: 200, em: 1000 };

  it('aceita o que está certo', () => {
    expect(leMarcador(bom)).toEqual(bom);
    expect(leEspelho({ marcador: bom, pendente: true })).toEqual({ marcador: bom, pendente: true });
  });

  it('lixo vira null, e nunca um NaN no player', () => {
    for (const ruim of [
      null,
      undefined,
      'texto',
      [],
      {},
      { ...bom, trackId: '' },
      { ...bom, trackId: 7 },
      { ...bom, pos: 'x' },
      { ...bom, pos: Number.NaN },
      { ...bom, pos: -1 },
      { ...bom, em: 0 },
      { ...bom, em: undefined },
    ]) {
      expect(leMarcador(ruim), JSON.stringify(ruim)).toBeNull();
    }
    expect(leEspelho({ pendente: true })).toBeNull();
    expect(leEspelho(null)).toBeNull();
  });

  it('duração torta vira zero em vez de derrubar o marcador', () => {
    expect(leMarcador({ ...bom, dur: 'x' })).toEqual({ ...bom, dur: 0 });
  });

  it('pendente só é verdade se for exatamente true', () => {
    expect(leEspelho({ marcador: bom })?.pendente).toBe(false);
    expect(leEspelho({ marcador: bom, pendente: 'sim' })?.pendente).toBe(false);
  });

  it('mais novo é pelo carimbo, e empate não é mais novo', () => {
    expect(maisNovo({ ...bom, em: 2 }, { ...bom, em: 1 })).toBe(true);
    expect(maisNovo({ ...bom, em: 1 }, { ...bom, em: 2 })).toBe(false);
    expect(maisNovo(bom, bom)).toBe(false);
  });
});

describe('decidirRestauracao', () => {
  const marcador: Marcador = { trackId: 'a', pos: 42, dur: 200, em: 1 };
  const base = { marcador, curId: null, deeplink: false, ids: new Set(['a', 'b']) };

  it('arma quando a faixa está na lista', () => {
    expect(decidirRestauracao(base)).toBe('armar');
  });

  it('sem marcador não há o que fazer', () => {
    expect(decidirRestauracao({ ...base, marcador: null })).toBe('nada');
  });

  it('o link de faixa vence o marcador', () => {
    expect(decidirRestauracao({ ...base, deeplink: true })).toBe('nada');
  });

  it('quem já deu play não é atropelado pela restauração', () => {
    expect(decidirRestauracao({ ...base, curId: 'b' })).toBe('nada');
    // Nem quando é a mesma faixa: recarregá-la pausada pararia a música.
    expect(decidirRestauracao({ ...base, curId: 'a' })).toBe('nada');
  });

  it('faixa pública fora da lista vale buscar por id', () => {
    expect(decidirRestauracao({ ...base, ids: new Set(['b']) })).toBe('buscar');
  });

  it('com a lista ainda chegando, faixa ausente espera em vez de desistir', () => {
    // O caso que justifica o recurso: faixa enviada e ouvida no desktop não
    // está no catálogo que o celular guardou ontem. Decidir pelo cache seria
    // desistir um segundo antes de ela chegar.
    const doAcervo = { ...marcador, trackId: 'acervo:11111111-1111-4111-8111-111111111111' };
    expect(decidirRestauracao({ ...base, marcador: doAcervo, atualizando: true })).toBe('esperar');
    expect(decidirRestauracao({ ...base, ids: new Set(['b']), atualizando: true })).toBe('esperar');
    // Mas o que já está na lista do cache arma na hora — é para isso que o cache serve.
    expect(decidirRestauracao({ ...base, atualizando: true })).toBe('armar');
    // E quem já deu play continua não sendo atropelado.
    expect(decidirRestauracao({ ...base, curId: 'b', atualizando: true })).toBe('nada');
  });

  it('faixa do acervo fora da lista não se busca nem se anuncia', () => {
    const doAcervo = { ...marcador, trackId: 'acervo:11111111-1111-4111-8111-111111111111' };
    expect(decidirRestauracao({ ...base, marcador: doAcervo })).toBe('nada');
    expect(
      decidirRestauracao({ ...base, marcador: doAcervo, ids: new Set([doAcervo.trackId]) }),
    ).toBe('armar');
  });
});

describe('fila do histórico', () => {
  const item = (trackId: string, em: number): ItemDoHistorico => ({
    trackId,
    titulo: trackId.toUpperCase(),
    artista: 'x',
    dur: 100,
    em,
  });
  const faixa = (id: string, extra: Partial<Track> = {}): Track => ({
    id,
    title: id.toUpperCase(),
    artist: 'x',
    genre: 'techno',
    dur: 100,
    art: 'capa',
    stream: 'url',
    ...extra,
  });

  it('a mesma faixa duas vezes vira uma, com a escuta mais recente', () => {
    let f = enfileirar([], item('a', 1));
    f = enfileirar(f, item('b', 2));
    f = enfileirar(f, item('a', 3));
    expect(f).toEqual([item('b', 2), item('a', 3)]);
  });

  it('não passa do teto de um pedido, e quem sai é a mais antiga', () => {
    let f: ItemDoHistorico[] = [];
    for (let i = 0; i < MAX_NA_FILA + 5; i += 1) f = enfileirar(f, item(`f${i}`, i + 1));
    expect(f).toHaveLength(MAX_NA_FILA);
    expect(f[0]!.trackId).toBe('f5');
    expect(f.at(-1)!.trackId).toBe(`f${MAX_NA_FILA + 4}`);
  });

  it('não muda a fila que recebeu', () => {
    const antes = [item('a', 1)];
    enfileirar(antes, item('b', 2));
    expect(antes).toEqual([item('a', 1)]);
  });

  it('o que entrou durante a subida sobrevive a ela', () => {
    const enviada = [item('a', 1), item('b', 2)];
    // `a` foi ouvida DE NOVO enquanto a primeira escuta subia: é outra escuta.
    const atual = [item('b', 2), item('a', 9), item('c', 10)];
    expect(semOQueSubiu(atual, enviada)).toEqual([item('a', 9), item('c', 10)]);
  });

  it('item torto do disco é descartado sozinho', () => {
    expect(
      leItens([
        item('a', 1),
        null,
        { trackId: '', em: 1 },
        { trackId: 'b' },
        { trackId: 'c', em: 'ontem' },
        { trackId: 'd', em: 5, titulo: 7, dur: -3 },
      ]),
    ).toEqual([item('a', 1), { trackId: 'd', titulo: '', artista: '', dur: 0, em: 5 }]);
    expect(leItens('lixo')).toEqual([]);
    expect(leItens(undefined)).toEqual([]);
  });

  it('o retrato corta no teto do servidor sem partir caractere', () => {
    const r = retratoDe(faixa('a', { title: '🎧'.repeat(300), artist: 'ã'.repeat(250), dur: 99.6 }), 7);
    expect([...r.titulo]).toHaveLength(200);
    expect(r.titulo.endsWith('🎧')).toBe(true);
    expect([...r.artista]).toHaveLength(200);
    expect(r).toMatchObject({ trackId: 'a', dur: 100, em: 7 });
  });

  it('a tela vê o servidor com a fila por cima, da mais recente para trás', () => {
    const servidor = [item('b', 20), item('a', 10)];
    const fila = [item('a', 30), item('c', 5)];
    expect(comAFila(servidor, fila).map((x) => [x.trackId, x.em])).toEqual([
      ['a', 30],
      ['b', 20],
      ['c', 5],
    ]);
  });

  it('faixa fora do catálogo sai como retrato, na ordem do histórico', () => {
    const tracks = [faixa('a'), faixa('b')];
    const lista = faixasDoHistorico([item('sumiu', 3), item('b', 2), item('a', 1)], tracks);
    expect(lista.map((t) => t.id)).toEqual(['sumiu', 'b', 'a']);
    // A que está no catálogo é a própria — capa e stream inclusive.
    expect(lista[1]).toBe(tracks[1]);
    // A que não está não tem como tocar nem como desenhar capa.
    expect(lista[0]).toEqual({
      id: 'sumiu',
      title: 'SUMIU',
      artist: 'x',
      genre: '',
      dur: 100,
      art: '',
      stream: '',
    });
  });
});

describe('HttpHistoricoService', () => {
  const marcador: Marcador = { trackId: 'a', pos: 42, dur: 200, em: 1000 };
  const novo = (r: Response) => {
    const fetchImpl = vi.fn(async (_rota: string, _init?: RequestInit) => r);
    return { fetchImpl, svc: new HttpHistoricoService(fetchImpl as unknown as typeof fetch) };
  };

  it('lê o marcador, e null é quem nunca ouviu nada', async () => {
    const { svc, fetchImpl } = novo(resposta(200, { marcador }));
    expect(await svc.marcador()).toEqual(marcador);
    expect(fetchImpl.mock.calls[0]![0]).toBe('/api/playback');
    expect(fetchImpl.mock.calls[0]![1]!.credentials).toBe('same-origin');

    expect(await novo(resposta(200, { marcador: null })).svc.marcador()).toBeNull();
  });

  it('404 na leitura é API antiga, e vale como sem marcador', async () => {
    // A PWA chega ao aparelho antes de o servidor novo subir.
    expect(await novo(resposta(404)).svc.marcador()).toBeNull();
  });

  it('404 na ESCRITA continua sendo erro', async () => {
    // Fingir sucesso aqui limparia o `pendente` de uma posição que ninguém guardou.
    await expect(novo(resposta(404)).svc.gravarMarcador(marcador)).rejects.toMatchObject({
      semSessao: false,
    });
  });

  it('grava com PUT e devolve o marcador que FICOU', async () => {
    const ficou = { ...marcador, trackId: 'do-outro-aparelho' };
    const { svc, fetchImpl } = novo(resposta(200, { marcador: ficou }));
    expect(await svc.gravarMarcador(marcador)).toEqual(ficou);
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual(marcador);
    expect(init.keepalive).toBeUndefined();
  });

  it('com a página saindo de cena, o pedido vai com keepalive', async () => {
    const { svc, fetchImpl } = novo(resposta(200, { marcador }));
    await svc.gravarMarcador(marcador, { keepalive: true });
    expect(fetchImpl.mock.calls[0]![1]!.keepalive).toBe(true);
  });

  it('401 é sessão expirada, e se diz assim', async () => {
    await expect(novo(resposta(401)).svc.marcador()).rejects.toMatchObject({ semSessao: true });
    await expect(novo(resposta(401)).svc.listar()).rejects.toMatchObject({ semSessao: true });
  });

  it('registra em lote e devolve a coleção inteira, peneirada', async () => {
    const itens = [{ trackId: 'a', titulo: 'A', artista: 'x', dur: 10, em: 5 }];
    const { svc, fetchImpl } = novo(resposta(200, { itens: [...itens, { trackId: 7 }] }));
    expect(await svc.registrar(itens)).toEqual(itens);
    expect(fetchImpl.mock.calls[0]![0]).toBe('/api/history');
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ itens });
  });

  it('limpar é um DELETE', async () => {
    const { svc, fetchImpl } = novo(resposta(200, { itens: [] }));
    expect(await svc.limpar()).toEqual([]);
    expect(fetchImpl.mock.calls[0]![1]!.method).toBe('DELETE');
  });

  it('resposta sem a lista vira lista vazia', async () => {
    expect(await novo(resposta(200, {})).svc.listar()).toEqual([]);
  });
});
