import {
  bufferShortLabel,
  fmtTime,
  LEGENDA,
  playerMode,
  userTag,
  type Track,
} from '@ondas/core';
import { CircleNotch, Pause, Play, SkipBack, SkipForward } from '@phosphor-icons/react';
import * as controller from '../app/controller';
import { useLibrary, usePlayer, useSession, useUi } from '../app/stores';
import { useAccountOverlay } from '../hooks/useAccountOverlay';
import { useNetwork } from '../hooks/useNetwork';
import { usePlayerOverlay } from '../hooks/usePlayerOverlay';
import { useWide } from '../hooks/useWide';
import s from './bottombar.module.css';
import { CassetteLogo } from './CassetteLogo';
import { Waveform } from './Waveform';

/** Toast → linha do player → status line. */
export function BottomBar({ track }: { track: Track | undefined }) {
  const toast = useUi((st) => st.toast);
  return (
    <div className={s.bar}>
      {toast && (
        <div className={s.toast}>
          <div className={s.toastInner} role="status">
            <span className={s.toastMark}>»</span> {toast}
          </div>
        </div>
      )}
      {track && <PlayerRow track={track} />}
      <StatusLine track={track} />
    </div>
  );
}

function PlayerRow({ track }: { track: Track }) {
  const wide = useWide();
  const { openPlayer } = usePlayerOverlay();
  const { t, dur, buf, playing, waiting } = usePlayer((st) => st);
  const cached = useLibrary((st) => !!st.cached[track.id]);

  const duration = dur || track.dur || 0;
  const played = duration ? t / duration : 0;
  const bufFraction = cached ? 1 : Math.max(buf, played);
  const mode = playerMode({ playing, waiting });

  return (
    <div className={s.player} onClick={openPlayer} role="presentation">
      <span className={`${s.mode} ${mode === 'PLAY' ? s.modePlay : s.modeIdle}`}>{mode}</span>
      <span className={s.logo}>
        <CassetteLogo playing={playing} progress={played} />
      </span>
      <span className={s.lines}>
        <button
          type="button"
          className={s.title}
          aria-label="Abrir player"
          onClick={(e) => {
            // Sem isto o clique sobe para a linha e empilha dois `?player=1`.
            e.stopPropagation();
            openPlayer();
          }}
        >
          {track.title} <span className={s.artist}>— {track.artist}</span>
        </button>
        <span className={s.progress}>
          {fmtTime(t)}
          <Waveform
            peaks={track.peaks}
            played={played}
            buf={bufFraction}
            onSeek={controller.seekFraction}
            className={s.wave}
          />
          {/* No estreito a linha inteira tem ~120px e os dois tempos comiam
              metade dela. A duração sai: ela está no player cheio, e o que
              importa aqui é onde a faixa está. */}
          {wide && fmtTime(duration)}
        </span>
      </span>
      <span className={s.controls}>
        <button
          type="button"
          className={s.skip}
          aria-label="Faixa anterior"
          onClick={(e) => {
            e.stopPropagation();
            controller.step(-1);
          }}
        >
          <SkipBack size={17} weight="fill" />
        </button>
        <button
          type="button"
          className={s.play}
          aria-label={playing ? 'Pausar' : 'Tocar'}
          onClick={(e) => {
            e.stopPropagation();
            controller.togglePlay();
          }}
        >
          <PlayIcon playing={playing} waiting={waiting} size={18} />
        </button>
        <button
          type="button"
          className={s.skip}
          aria-label="Próxima faixa"
          onClick={(e) => {
            e.stopPropagation();
            controller.step(1);
          }}
        >
          <SkipForward size={17} weight="fill" />
        </button>
      </span>
    </div>
  );
}

function StatusLine({ track }: { track: Track | undefined }) {
  const wide = useWide();
  const user = useSession((st) => st.user);
  const { t, dur, buf } = usePlayer((st) => st);
  const cached = useLibrary((st) => (track ? !!st.cached[track.id] : false));
  const { offline } = useNetwork();
  const { openAccount } = useAccountOverlay();

  const duration = dur || track?.dur || 0;
  const ahead = Math.max(0, (cached ? 1 : buf) * duration - t);

  return (
    <div className={s.status}>
      <div className={s.statusInner}>
        {/* O próprio nome é a porta da conta: ele já está na tela e já
            significa "você". Abrir conta daqui evita um ícone novo na barra
            de cima, e fica na zona do polegar. */}
        <button
          type="button"
          className={s.quem}
          aria-label="Conta e aparelho"
          onClick={(e) => {
            e.stopPropagation();
            openAccount();
          }}
        >
          {userTag(user)}
        </button>
        {track && <span>{bufferShortLabel(cached, ahead)}</span>}
        <span className={s.spacer} />
        {wide && (
          <span>
            {LEGENDA.map(([key, label]) => (
              <span key={key}>
                <span className={s.legendKey}>{key}</span> {label}
                {'  '}
              </span>
            ))}
          </span>
        )}
        {/* Rede na ponta direita: o nome (porta da conta) abre a linha à
            esquerda, onde o olho começa. Em produção o indicador só reflete
            a rede; a simulação é ferramenta de dev. */}
        {import.meta.env.DEV ? (
          <button
            type="button"
            className={`${s.net} ${s.netToggle} ${offline ? s.netOffline : ''}`}
            onClick={controller.toggleSimulatedOffline}
            title="Simular queda de rede (o)"
          >
            ● {offline ? 'offline' : 'online'}
          </button>
        ) : (
          <span className={`${s.net} ${offline ? s.netOffline : ''}`}>
            ● {offline ? 'offline' : 'online'}
          </span>
        )}
      </div>
    </div>
  );
}

/** Play, pause ou spinner de buffering — a mesma lógica de ícone do protótipo. */
export function PlayIcon({
  playing,
  waiting,
  size,
}: {
  playing: boolean;
  waiting: boolean;
  size: number;
}) {
  if (waiting && playing) return <CircleNotch size={size} className={s.spin} />;
  return playing ? <Pause size={size} weight="fill" /> : <Play size={size} weight="fill" />;
}
