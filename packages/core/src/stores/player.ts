import { createStore } from 'zustand/vanilla';

export interface PlayerState {
  /** Índice na lista de faixas, -1 quando nada carregado. */
  cur: number;
  /** Id da faixa atual — sobrevive a reordenações da lista. */
  curId: string | null;
  playing: boolean;
  waiting: boolean;
  /** Posição em segundos. */
  t: number;
  /** Duração em segundos. */
  dur: number;
  /** Fração em buffer, 0..1. */
  buf: number;
  shuffle: boolean;
  repeat: boolean;
  load(index: number, trackId: string, dur: number, buf: number): void;
  patch(partial: Partial<Omit<PlayerState, keyof PlayerActions>>): void;
  toggleShuffle(): void;
  toggleRepeat(): void;
  reset(): void;
}

type PlayerActions = Pick<PlayerState, 'load' | 'patch' | 'toggleShuffle' | 'toggleRepeat' | 'reset'>;

export type PlayerStore = ReturnType<typeof createPlayerStore>;

const EMPTY = {
  cur: -1,
  curId: null,
  playing: false,
  waiting: false,
  t: 0,
  dur: 0,
  buf: 0,
} as const;

export function createPlayerStore() {
  return createStore<PlayerState>((set) => ({
    ...EMPTY,
    shuffle: false,
    repeat: false,
    load: (cur, curId, dur, buf) => set({ cur, curId, dur, buf, t: 0, playing: true, waiting: true }),
    patch: (partial) => set(partial),
    toggleShuffle: () => set((s) => ({ shuffle: !s.shuffle })),
    toggleRepeat: () => set((s) => ({ repeat: !s.repeat })),
    reset: () => set({ ...EMPTY }),
  }));
}

/** Bloco de modo da player row, estilo vim. */
export function playerMode(s: Pick<PlayerState, 'playing' | 'waiting'>): 'PLAY' | 'PAUSE' | 'BUF' {
  if (s.waiting && s.playing) return 'BUF';
  return s.playing ? 'PLAY' : 'PAUSE';
}
