import type { Track } from '../types.js';

/**
 * Motor de áudio. Na web é um `HTMLAudioElement`; no nativo será
 * `react-native-track-player`. Nenhuma implementação pertence a `core`.
 */
export interface PlayerEngineEvents {
  /** Posição atual, em segundos. */
  time: number;
  /** Fração em buffer, 0..1. */
  buffer: number;
  ended: void;
  /** `true` enquanto o motor espera dados. */
  waiting: boolean;
  /** `true` tocando, `false` pausado. */
  playing: boolean;
  /** Duração conhecida, em segundos. */
  duration: number;
  error: Error;
}

export type PlayerEventName = keyof PlayerEngineEvents;
export type Unsubscribe = () => void;

export interface PlayerEngine {
  /** Carrega a faixa. `src` vazio = sem fonte tocável (cai no playback simulado). */
  load(track: Track, src: string): Promise<void> | void;
  play(): Promise<void> | void;
  pause(): void;
  /** Posiciona em segundos absolutos. */
  seek(seconds: number): void;
  /** Posição atual, em segundos. */
  currentTime(): number;
  duration(): number;
  on<E extends PlayerEventName>(event: E, cb: (payload: PlayerEngineEvents[E]) => void): Unsubscribe;
  destroy(): void;
}
