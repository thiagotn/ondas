import { describe, expect, it, vi } from 'vitest';
import {
  FILA_VAZIA,
  aplicarFila,
  enfileirar,
  filaVazia,
  leFila,
  semOQueSubiu,
} from '../likes/fila.js';
import { HttpLikesService } from '../likes/http.js';
import { LikesError } from '../ports/likes.js';

const resposta = (status: number, corpo?: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (corpo === undefined) throw new Error('sem json');
      return corpo;
    },
  }) as Response;

describe('fila de curtidas', () => {
  it('as duas listas nunca têm o mesmo id', () => {
    // É este invariante que dispensa o servidor de decidir uma ordem entre
    // apagar e inserir.
    let f = enfileirar(FILA_VAZIA, 'demo1', false);
    expect(f).toEqual({ add: [], remove: ['demo1'] });

    f = enfileirar(f, 'demo1', true);
    expect(f).toEqual({ add: ['demo1'], remove: [] });
  });

  it('curtir, descurtir e curtir de novo sem rede vira um add só', () => {
    let f = enfileirar(FILA_VAZIA, 'demo1', true);
    f = enfileirar(f, 'demo1', false);
    f = enfileirar(f, 'demo1', true);
    expect(f).toEqual({ add: ['demo1'], remove: [] });
  });

  it('descurtir o que nunca entrou no add ainda vira remove', () => {
    // A faixa já estava curtida no SERVIDOR; a fila local nunca a viu.
    expect(enfileirar(FILA_VAZIA, 'demo1', false)).toEqual({ add: [], remove: ['demo1'] });
  });

  it('ids diferentes convivem', () => {
    let f = enfileirar(FILA_VAZIA, 'a', true);
    f = enfileirar(f, 'b', false);
    f = enfileirar(f, 'c', true);
    expect(f).toEqual({ add: ['a', 'c'], remove: ['b'] });
    expect(filaVazia(f)).toBe(false);
    expect(filaVazia(FILA_VAZIA)).toBe(true);
  });

  it('não muda a fila que recebeu', () => {
    const antes = enfileirar(FILA_VAZIA, 'a', true);
    enfileirar(antes, 'b', true);
    expect(antes).toEqual({ add: ['a'], remove: [] });
  });

  it('fila estranha vinda do disco vira fila vazia, não explosão no boot', () => {
    expect(leFila(undefined)).toEqual(FILA_VAZIA);
    expect(leFila('curtidas')).toEqual(FILA_VAZIA);
    expect(leFila({ add: 'demo1' })).toEqual(FILA_VAZIA);
    expect(leFila({ add: ['a', 7, '', null], remove: ['b'] })).toEqual({
      add: ['a'],
      remove: ['b'],
    });
  });
});

describe('a corrida entre a fila e a resposta', () => {
  it('a fila que ficou entra por cima do que o servidor respondeu', () => {
    // O servidor não sabe do coração que a pessoa tocou durante o voo.
    expect(aplicarFila(['a', 'b'], { add: ['c'], remove: ['a'] })).toEqual(['b', 'c']);
  });

  it('não duplica o que o servidor já tem', () => {
    expect(aplicarFila(['a'], { add: ['a'], remove: [] })).toEqual(['a']);
  });

  it('subir a fila não joga fora o que entrou nela durante o voo', () => {
    const enviada = enfileirar(FILA_VAZIA, 'a', true);
    // Durante o voo: curtiu 'b' e descurtiu 'a'.
    let agora = enfileirar(enviada, 'b', true);
    agora = enfileirar(agora, 'a', false);

    // 'a' mudou de lado, então sobrevive — o `add` que subiu não casa com o
    // `remove` que ficou.
    expect(semOQueSubiu(agora, enviada)).toEqual({ add: ['b'], remove: ['a'] });
  });

  it('o que subiu e não mudou sai da fila', () => {
    const enviada: ReturnType<typeof enfileirar> = { add: ['a'], remove: ['b'] };
    expect(semOQueSubiu(enviada, enviada)).toEqual(FILA_VAZIA);
  });
});

describe('HttpLikesService', () => {
  it('lê a coleção', async () => {
    const fetchImpl = vi.fn(async (_rota: string, _init?: RequestInit) =>
      resposta(200, { ids: ['a', 'b'] }),
    );
    const svc = new HttpLikesService(fetchImpl as unknown as typeof fetch);
    expect(await svc.list()).toEqual(['a', 'b']);
    expect(fetchImpl.mock.calls[0]![0]).toBe('/api/likes');
  });

  it('manda as duas listas num PATCH e devolve o que o servidor respondeu', async () => {
    const fetchImpl = vi.fn(async (_rota: string, _init?: RequestInit) =>
      resposta(200, { ids: ['a', 'c'] }),
    );
    const svc = new HttpLikesService(fetchImpl as unknown as typeof fetch);

    expect(await svc.apply(['c'], ['b'])).toEqual(['a', 'c']);
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(init.method).toBe('PATCH');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(init.body as string)).toEqual({ add: ['c'], remove: ['b'] });
  });

  it('401 é sessão expirada, e se diz assim', async () => {
    const svc = new HttpLikesService((async () => resposta(401)) as unknown as typeof fetch);
    // `semSessao` é o que separa "mandar para o login" de "tentar de novo
    // depois" — sem ele a fila ficaria insistindo contra um 401.
    await expect(svc.list()).rejects.toMatchObject({ semSessao: true });
    await expect(svc.apply(['a'], [])).rejects.toBeInstanceOf(LikesError);
  });

  it('outro erro não é sessão expirada', async () => {
    const svc = new HttpLikesService((async () => resposta(500)) as unknown as typeof fetch);
    await expect(svc.list()).rejects.toMatchObject({ semSessao: false });
  });

  it('corpo estranho não vira id', async () => {
    const svc = new HttpLikesService(
      (async () => resposta(200, { ids: ['a', 3, '', { x: 1 }] })) as unknown as typeof fetch,
    );
    expect(await svc.list()).toEqual(['a']);

    const semIds = new HttpLikesService(
      (async () => resposta(200, {})) as unknown as typeof fetch,
    );
    expect(await semIds.list()).toEqual([]);
  });
});
