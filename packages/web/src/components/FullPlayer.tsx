import {
  barCount,
  bufferBar,
  bufferSourceLabel,
  fmtTime,
  type Track,
} from '@ondas/core';
import {
  CheckCircle,
  DownloadSimple,
  Heart,
  RepeatOnce,
  Shuffle,
  SkipBack,
  SkipForward,
} from '@phosphor-icons/react';
import * as controller from '../app/controller';
import { playerStore, useLibrary, usePlayer, useSession } from '../app/stores';
import { usePlayerOverlay } from '../hooks/usePlayerOverlay';
import { useViewportWidth, useWide } from '../hooks/useWide';
import { PlayIcon } from './BottomBar';
import { CassetteLogo } from './CassetteLogo';
import s from './overlay.module.css';
import { Waveform } from './Waveform';

/** Overlay de tela cheia da faixa atual. Fechado pelo Esc e pelo botão voltar. */
export function FullPlayer({ track }: { track: Track }) {
  const wide = useWide();
  const viewportWidth = useViewportWidth();
  const { closePlayer } = usePlayerOverlay();
  const { t, dur, buf, playing, waiting, shuffle, repeat, curId } = usePlayer((st) => st);
  const user = useSession((st) => st.user);
  const cached = useLibrary((st) => !!st.cached[track.id]);
  const liked = useLibrary((st) => !!st.liked[track.id]);
  const downloading = useLibrary((st) => st.dl[track.id] ?? null);

  const duration = dur || track.dur || 0;
  const played = duration ? t / duration : 0;
  const bufFraction = cached ? 1 : Math.max(buf, played);
  const ahead = Math.max(0, bufFraction * duration - t);
  const bar = bufferBar(played, bufFraction);

  return (
    <div className={s.fullscreen}>
      <div className={s.panel}>
        <span className={s.label}>agora-tocando — #{track.genre}</span>
        <button type="button" className={s.close} onClick={closePlayer}>
          [esc] fechar
        </button>

        <div className={s.body}>
          <div className={s.cover}>
            {track.art ? (
              <img src={track.art} alt="" decoding="async" />
            ) : (
              <div className={s.coverLogo}>
                <CassetteLogo playing={playing} progress={played} label />
              </div>
            )}
          </div>

          <div className={s.info}>
            <div className={s.infoHead}>
              <span className={s.infoLabel}>titulo</span>
              <h2 className={s.infoTitle}>{track.title}</h2>
              <span className={s.infoArtist}>{track.artist}</span>
            </div>

            <div className={s.waveBlock}>
              <Waveform
                trackId={curId}
                bars={barCount(viewportWidth, wide)}
                played={played}
                buf={bufFraction}
                onSeek={controller.seekFraction}
                className={s.wave}
              />
              <div className={s.times}>
                <span>{fmtTime(t)}</span>
                <span>{fmtTime(duration)}</span>
              </div>
            </div>

            <div className={s.keycaps}>
              <Keycap
                keyLabel="s"
                active={shuffle}
                ariaLabel="Aleatório"
                onClick={() => playerStore.getState().toggleShuffle()}
              >
                <Shuffle size={19} />
              </Keycap>
              <Keycap keyLabel="p" ariaLabel="Faixa anterior" onClick={() => controller.step(-1)}>
                <SkipBack size={19} weight="fill" />
              </Keycap>
              <Keycap keyLabel="espaço" active ariaLabel={playing ? 'Pausar' : 'Tocar'} onClick={controller.togglePlay}>
                <PlayIcon playing={playing} waiting={waiting} size={19} />
              </Keycap>
              <Keycap keyLabel="n" ariaLabel="Próxima faixa" onClick={() => controller.step(1)}>
                <SkipForward size={19} weight="fill" />
              </Keycap>
              <Keycap
                keyLabel="r"
                active={repeat}
                ariaLabel="Repetir faixa"
                onClick={() => playerStore.getState().toggleRepeat()}
              >
                <RepeatOnce size={19} />
              </Keycap>
              <Keycap
                keyLabel="l"
                active={liked}
                ariaLabel={liked ? 'Descurtir' : 'Curtir'}
                onClick={() => controller.toggleLike(track.id)}
              >
                <Heart size={19} weight={liked ? 'fill' : 'regular'} />
              </Keycap>
              <Keycap
                keyLabel="d"
                active={cached}
                ariaLabel={cached ? 'Remover do aparelho' : 'Baixar'}
                onClick={() => void controller.download(track)}
              >
                {cached ? <CheckCircle size={19} weight="fill" /> : <DownloadSimple size={19} />}
              </Keycap>
            </div>

            <div className={s.buffer}>
              <div className={s.bufferRow}>
                <span className={s.bufferLabel}>buffer</span>
                <span className={s.bufferBar}>
                  <span className={s.bufferPlayed}>{bar.a}</span>
                  <span className={s.bufferAhead}>{bar.b}</span>
                  <span className={s.bufferRest}>{bar.c}</span>
                </span>
              </div>
              <div className={s.bufferRow}>
                <span className={s.bufferLabel}>fonte</span>
                <span className={cached ? s.sourceLocal : s.sourceRemote}>
                  {bufferSourceLabel({ cached, downloading, hasStream: !!track.stream, ahead })}
                </span>
              </div>
              {!cached && downloading == null && (
                <button
                  type="button"
                  className={s.dlButton}
                  onClick={() => void controller.download(track)}
                >
                  {user ? '[d] baixar para offline' : '[d] entrar para baixar'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Keycap({
  children,
  keyLabel,
  active,
  ariaLabel,
  onClick,
}: {
  children: React.ReactNode;
  keyLabel: string;
  active?: boolean;
  ariaLabel: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      className={active ? `${s.keycap} ${s.keycapOn}` : s.keycap}
      onClick={onClick}
    >
      {children}
      <span className={s.keycapKey}>{keyLabel}</span>
    </button>
  );
}
