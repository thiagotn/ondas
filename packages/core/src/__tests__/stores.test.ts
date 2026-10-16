import { describe, expect, it, vi } from 'vitest';
import { createLibraryStore, offlineBytes } from '../stores/library.js';
import { createPlayerStore, playerMode } from '../stores/player.js';
import { createSessionStore, planLabel, userTag, whoAmI } from '../stores/session.js';
import { createUiStore, gateCopy, TOAST_MS } from '../stores/ui.js';

describe('session store', () => {
  it('entra, sai e marca a restauração', () => {
    const s = createSessionStore();
    expect(s.getState().user).toBeNull();
    expect(s.getState().restored).toBe(false);
    s.getState().markRestored({ name: 'thiago' });
    expect(s.getState()).toMatchObject({ restored: true, user: { name: 'thiago' } });
    s.getState().setUser(null);
    expect(s.getState().user).toBeNull();
  });

  it('rotula visitante e assinante', () => {
    expect(userTag(null)).toBe('visitante');
    expect(userTag({ name: 'thiago' })).toBe('@thiago');
    expect(whoAmI(null)).toBe('visitante');
    expect(planLabel(null)).toBe('somente faixas grátis');
    expect(planLabel({ name: 'thiago' })).toBe('catálogo completo + offline');
  });
});

describe('player store', () => {
  it('carregar uma faixa zera o tempo e entra em espera', () => {
    const p = createPlayerStore();
    p.getState().load(3, 'demo3', 214, 0);
    expect(p.getState()).toMatchObject({ cur: 3, curId: 'demo3', dur: 214, t: 0, playing: true, waiting: true });
  });

  it('alterna shuffle e repeat e volta ao estado vazio', () => {
    const p = createPlayerStore();
    p.getState().toggleShuffle();
    p.getState().toggleRepeat();
    p.getState().load(1, 'demo1', 100, 0);
    p.getState().reset();
    expect(p.getState()).toMatchObject({ cur: -1, curId: null, playing: false, shuffle: true, repeat: true });
  });

  it('mapeia o bloco de modo', () => {
    expect(playerMode({ playing: true, waiting: false })).toBe('PLAY');
    expect(playerMode({ playing: false, waiting: false })).toBe('PAUSE');
    expect(playerMode({ playing: true, waiting: true })).toBe('BUF');
    expect(playerMode({ playing: false, waiting: true })).toBe('PAUSE');
  });
});

describe('library store', () => {
  it('persiste curtidas, cache e preferência de buffer', () => {
    const persist = vi.fn();
    const lib = createLibraryStore({ persist });
    lib.getState().toggleLike('demo1');
    lib.getState().markCached('demo1', 4_000_000);
    lib.getState().togglePrefetch();
    expect(lib.getState().liked).toEqual({ demo1: true });
    expect(lib.getState().prefetch).toBe(false);
    expect(persist).toHaveBeenCalledTimes(3);
    expect(persist.mock.calls.at(-1)![0]).toMatchObject({
      liked: { demo1: true },
      cached: { demo1: true },
      sizes: { demo1: 4_000_000 },
      prefetch: false,
    });
  });

  it('descurtir remove a chave', () => {
    const lib = createLibraryStore();
    lib.getState().toggleLike('demo1');
    lib.getState().toggleLike('demo1');
    expect(lib.getState().liked).toEqual({});
  });

  it('remover do aparelho limpa índice e tamanho', () => {
    const lib = createLibraryStore();
    lib.getState().markCached('demo1', 100);
    lib.getState().unmarkCached('demo1');
    expect(lib.getState().cached).toEqual({});
    expect(lib.getState().sizes).toEqual({});
  });

  it('progresso de download é efêmero', () => {
    const persist = vi.fn();
    const lib = createLibraryStore({ persist });
    lib.getState().setDl('demo1', 0.5);
    expect(lib.getState().dl).toEqual({ demo1: 0.5 });
    lib.getState().setDl('demo1', null);
    expect(lib.getState().dl).toEqual({});
    expect(persist).not.toHaveBeenCalled();
  });

  it('reconcilia o índice com o que o aparelho ainda tem', () => {
    const lib = createLibraryStore({
      initial: { cached: { a: true, b: true }, sizes: { a: 10, b: 20 }, prefetch: true, liked: {} },
    });
    lib.getState().reconcile(['b']);
    expect(lib.getState().cached).toEqual({ b: true });
    expect(lib.getState().sizes).toEqual({ b: 20 });
  });

  it('soma os bytes das faixas presentes', () => {
    expect(offlineBytes({ cached: { a: true, b: true }, sizes: { a: 1048576, b: 2097152 } })).toBe(
      3145728,
    );
    expect(offlineBytes({ cached: { a: true }, sizes: {} })).toBe(0);
  });
});

describe('ui store', () => {
  it('toast expira sozinho e uma mensagem nova substitui a anterior', () => {
    vi.useFakeTimers();
    const ui = createUiStore();
    ui.getState().flash('salva no aparelho');
    expect(ui.getState().toast).toBe('salva no aparelho');
    vi.advanceTimersByTime(TOAST_MS - 100);
    ui.getState().flash('removida do aparelho');
    expect(ui.getState().toast).toBe('removida do aparelho');
    vi.advanceTimersByTime(TOAST_MS);
    expect(ui.getState().toast).toBe('');
    vi.useRealTimers();
  });

  it('abre e fecha gate e picker', () => {
    const ui = createUiStore();
    ui.getState().openGate('dl', 'Dobra');
    expect(ui.getState().gate).toEqual({ kind: 'dl', title: 'Dobra' });
    ui.getState().closeGate();
    ui.getState().openPicker(4);
    expect(ui.getState()).toMatchObject({ gate: null, pickerOpen: true, pickIdx: 4 });
    ui.getState().closePicker();
    expect(ui.getState().pickerOpen).toBe(false);
  });

  it('escreve a cópia certa em cada gate', () => {
    expect(gateCopy({ kind: 'play', title: 'Dobra' })).toEqual({
      title: '"Dobra" é uma faixa [pro]',
      body: 'entre gratuitamente para liberar o catálogo completo — ou continue ouvindo as faixas grátis.',
    });
    expect(gateCopy({ kind: 'dl', title: 'Dobra' }).body).toBe(
      'entre na sua conta para salvar "Dobra" no aparelho e ouvir sem conexão.',
    );
  });
});
