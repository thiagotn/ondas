import type { PlayerEngine, PlayerEngineEvents, PlayerEventName, Track, Unsubscribe } from '@ondas/core';

type Handler = (payload: never) => void;

/** Passo do playback simulado, em segundos (o mesmo tick de 250 ms do protótipo). */
const SIM_STEP = 0.25;
/** Buffer fictício à frente, para a waveform não ficar morta na prévia. */
const SIM_BUFFER_AHEAD = 40;

/**
 * Motor de áudio da web: um único `HTMLAudioElement`.
 *
 * Faixas sem `stream` (catálogo demo) caem no **playback simulado** — um
 * cronômetro que avança o tempo e o buffer sem áudio, para a UI continuar
 * demonstrável sem rede nem API.
 */
export class WebPlayerEngine implements PlayerEngine {
  private audio: HTMLAudioElement;
  private handlers = new Map<PlayerEventName, Set<Handler>>();
  private sim: ReturnType<typeof setInterval> | null = null;
  private simTime = 0;
  private simDur = 0;
  private simBuf = 0;
  private simulated = false;

  constructor() {
    const a = (this.audio = new Audio());
    a.preload = 'auto';
    a.crossOrigin = 'anonymous';
    a.addEventListener('timeupdate', () => this.emit('time', a.currentTime));
    a.addEventListener('durationchange', () => {
      if (Number.isFinite(a.duration)) this.emit('duration', a.duration);
    });
    a.addEventListener('progress', () => {
      const b = a.buffered;
      if (b.length && a.duration) this.emit('buffer', b.end(b.length - 1) / a.duration);
    });
    a.addEventListener('waiting', () => this.emit('waiting', true));
    a.addEventListener('playing', () => {
      this.emit('waiting', false);
      this.emit('playing', true);
    });
    a.addEventListener('pause', () => this.emit('playing', false));
    a.addEventListener('ended', () => this.emit('ended', undefined));
    a.addEventListener('error', () => {
      // Sem src o browser dispara `error` ao limpar o elemento: não é falha real.
      if (!a.getAttribute('src')) return;
      this.emit('waiting', false);
      this.emit('error', new Error('stream indisponível'));
    });
  }

  /** `true` quando a faixa atual roda em modo simulado. */
  isSimulated(): boolean {
    return this.simulated;
  }

  load(track: Track, src: string): void {
    this.stopSim();
    this.audio.pause();
    this.simulated = !src;
    if (!src) {
      this.audio.removeAttribute('src');
      this.simDur = track.dur || 200;
      this.simTime = 0;
      this.simBuf = 0;
      this.emit('duration', this.simDur);
      return;
    }
    this.audio.src = src;
    this.audio.load();
  }

  async play(): Promise<void> {
    if (this.simulated) {
      this.startSim();
      this.emit('playing', true);
      this.emit('waiting', false);
      return;
    }
    try {
      await this.audio.play();
    } catch {
      // Autoplay barrado ou faixa inválida: a UI volta para PAUSE.
      this.emit('playing', false);
      this.emit('waiting', false);
    }
  }

  pause(): void {
    if (this.simulated) {
      this.stopSim();
      this.emit('playing', false);
      return;
    }
    this.audio.pause();
  }

  isPaused(): boolean {
    return this.simulated ? this.sim === null : this.audio.paused;
  }

  seek(seconds: number): void {
    if (this.simulated) {
      this.simTime = Math.min(this.simDur, Math.max(0, seconds));
      this.emit('time', this.simTime);
      return;
    }
    if (Number.isFinite(this.audio.duration)) {
      this.audio.currentTime = Math.min(this.audio.duration, Math.max(0, seconds));
    }
  }

  currentTime(): number {
    return this.simulated ? this.simTime : this.audio.currentTime;
  }

  duration(): number {
    if (this.simulated) return this.simDur;
    return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
  }

  on<E extends PlayerEventName>(event: E, cb: (payload: PlayerEngineEvents[E]) => void): Unsubscribe {
    const set = this.handlers.get(event) ?? new Set<Handler>();
    set.add(cb as Handler);
    this.handlers.set(event, set);
    return () => set.delete(cb as Handler);
  }

  destroy(): void {
    this.stopSim();
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.handlers.clear();
  }

  private emit<E extends PlayerEventName>(event: E, payload: PlayerEngineEvents[E]): void {
    for (const h of this.handlers.get(event) ?? []) (h as (p: PlayerEngineEvents[E]) => void)(payload);
  }

  private startSim(): void {
    if (this.sim) return;
    this.sim = setInterval(() => {
      this.simTime += SIM_STEP;
      if (this.simTime >= this.simDur) {
        this.stopSim();
        this.simTime = this.simDur;
        this.emit('time', this.simTime);
        this.emit('ended', undefined);
        return;
      }
      this.simBuf = Math.min(1, Math.max(this.simBuf, (this.simTime + SIM_BUFFER_AHEAD) / this.simDur));
      this.emit('time', this.simTime);
      this.emit('buffer', this.simBuf);
    }, SIM_STEP * 1000);
  }

  private stopSim(): void {
    if (!this.sim) return;
    clearInterval(this.sim);
    this.sim = null;
  }
}
