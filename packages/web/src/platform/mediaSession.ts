import type { Track } from '@ondas/core';

export interface MediaSessionActions {
  play(): void;
  pause(): void;
  next(): void;
  prev(): void;
  seekTo(seconds: number): void;
  seekBy(offset: number): void;
}

const supported = () => typeof navigator !== 'undefined' && 'mediaSession' in navigator;

/** Metadados da tela de bloqueio / controles de mídia do SO. */
export function setMediaMetadata(track: Track | null): void {
  if (!supported()) return;
  if (!track) {
    navigator.mediaSession.metadata = null;
    return;
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: 'ondas',
    artwork: track.art ? [{ src: track.art, sizes: '480x480', type: 'image/jpeg' }] : [],
  });
}

export function setMediaPlaybackState(playing: boolean): void {
  if (!supported()) return;
  navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

/** Posição para a barra de progresso dos controles nativos. */
export function setMediaPosition(position: number, duration: number): void {
  if (!supported() || !navigator.mediaSession.setPositionState) return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      position: Math.min(Math.max(0, position), duration),
      playbackRate: 1,
    });
  } catch {
    /* alguns navegadores recusam posições fora de ordem */
  }
}

/** Liga fones de ouvido e tela de bloqueio aos mesmos comandos da UI. */
export function bindMediaSessionActions(actions: MediaSessionActions): () => void {
  if (!supported()) return () => {};
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ['play', () => actions.play()],
    ['pause', () => actions.pause()],
    ['nexttrack', () => actions.next()],
    ['previoustrack', () => actions.prev()],
    ['seekforward', (d) => actions.seekBy(d.seekOffset ?? 10)],
    ['seekbackward', (d) => actions.seekBy(-(d.seekOffset ?? 10))],
    ['seekto', (d) => d.seekTime != null && actions.seekTo(d.seekTime)],
    ['stop', () => actions.pause()],
  ];
  for (const [name, handler] of handlers) {
    try {
      navigator.mediaSession.setActionHandler(name, handler);
    } catch {
      // Ação não suportada neste navegador.
    }
  }
  return () => {
    for (const [name] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(name, null);
      } catch {
        /* idem */
      }
    }
  };
}
