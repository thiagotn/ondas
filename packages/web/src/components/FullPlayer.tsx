import {
  artworkHosts,
  artworkSources,
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
  ShareNetwork,
  Shuffle,
  SkipBack,
  SkipForward,
} from '@phosphor-icons/react';
import { useMemo } from 'react';
import * as controller from '../app/controller';
import { playerStore, useLibrary, usePlayer, useSession } from '../app/stores';
import { usePlayerOverlay } from '../hooks/usePlayerOverlay';
import { useWide } from '../hooks/useWide';
import { useCatalog } from '../query/catalog';
import { PlayIcon } from './BottomBar';
import { CassetteLogo } from './CassetteLogo';
import s from './overlay.module.css';
import { TrackArt } from './TrackArt';
import { Waveform } from './Waveform';

/** Overlay de tela cheia da faixa atual. Fechado pelo Esc e pelo botão voltar. */
export function FullPlayer({ track }: { track: Track }) {
  const wide = useWide();
  const { closePlayer } = usePlayerOverlay();
  const { t, dur, buf, playing, waiting, shuffle, repeat } = usePlayer((st) => st);
  const user = useSession((st) => st.user);
  const cached = useLibrary((st) => !!st.cached[track.id]);
  const liked = useLibrary((st) => !!st.liked[track.id]);
  const downloading = useLibrary((st) => st.dl[track.id] ?? null);

  const { data } = useCatalog();
  const capa = useMemo(
    () => artworkSources(track.art, artworkHosts(data?.tracks ?? [])),
    [track.art, data?.tracks],
  );

  // No celular não há teclado, então a legenda da tecla some — e sem ela as
  // sete ações cabem numa linha só. Mesmo critério das abas (TabBar) e da
  // legenda do rodapé (BottomBar), que já faziam isso; o player é que ficou
  // para trás.
  const dica = (tecla: string) => (wide ? tecla : undefined);

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
          {wide ? '[esc] fechar' : 'fechar'}
        </button>

        <div className={s.body}>
          <div className={s.cover}>
            {capa.length ? (
              <TrackArt sources={capa} />
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
                peaks={track.peaks}
                played={played}
                buf={bufFraction}
                dur={duration}
                mirror
                onSeek={controller.seekFraction}
                className={s.wave}
              />
              <div className={s.times}>
                <span className={s.timeNow}>{fmtTime(t)}</span>
                <span>{fmtTime(duration)}</span>
              </div>
            </div>

            <div className={wide ? s.keycaps : `${s.keycaps} ${s.keycapsLinha}`}>
              <Keycap
                keyLabel={dica('s')}
                active={shuffle}
                ariaLabel="Aleatório"
                onClick={() => playerStore.getState().toggleShuffle()}
              >
                <Shuffle size={19} />
              </Keycap>
              <Keycap keyLabel={dica('p')} ariaLabel="Faixa anterior" onClick={() => controller.step(-1)}>
                <SkipBack size={19} weight="fill" />
              </Keycap>
              <Keycap keyLabel={dica('espaço')} active ariaLabel={playing ? 'Pausar' : 'Tocar'} onClick={controller.togglePlay}>
                <PlayIcon playing={playing} waiting={waiting} size={19} />
              </Keycap>
              <Keycap keyLabel={dica('n')} ariaLabel="Próxima faixa" onClick={() => controller.step(1)}>
                <SkipForward size={19} weight="fill" />
              </Keycap>
              <Keycap
                keyLabel={dica('r')}
                active={repeat}
                ariaLabel="Repetir faixa"
                onClick={() => playerStore.getState().toggleRepeat()}
              >
                <RepeatOnce size={19} />
              </Keycap>
              <Keycap
                keyLabel={dica('l')}
                active={liked}
                ariaLabel={liked ? 'Descurtir' : 'Curtir'}
                onClick={() => controller.toggleLike(track.id)}
              >
                <Heart size={19} weight={liked ? 'fill' : 'regular'} />
              </Keycap>
              <Keycap
                keyLabel={dica('d')}
                active={cached}
                ariaLabel={cached ? 'Remover do aparelho' : 'Baixar'}
                onClick={() => void controller.download(track)}
              >
                {cached ? <CheckCircle size={19} weight="fill" /> : <DownloadSimple size={19} />}
              </Keycap>
              <Keycap
                keyLabel={dica('c')}
                ariaLabel="Compartilhar"
                onClick={() => controller.shareCurrent()}
              >
                <ShareNetwork size={19} />
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
                  {wide ? '[d] ' : ''}
                  {user ? 'baixar para offline' : 'entrar para baixar'}
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
  /** Ausente no estreito: sem teclado, a letra é só ruído. */
  keyLabel?: string;
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
      {keyLabel && <span className={s.keycapKey}>{keyLabel}</span>}
    </button>
  );
}
