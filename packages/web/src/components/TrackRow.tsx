import { CheckCircle, DownloadSimple, Heart } from '@phosphor-icons/react';
import type { RowModel } from '../hooks/useTrackRows';
import s from './row.module.css';
import { TrackArt } from './TrackArt';

export interface TrackRowProps {
  row: RowModel;
  /** Thumbnail só aparece no wide. */
  showArt: boolean;
  onPlay(index: number): void;
  onLike(id: string): void;
  onDownload(row: RowModel): void;
}

/** `[01] [capa] titulo / artista #genero m:ss  [pro] [off] [ 42%]  ♥  ↓` */
export function TrackRow({ row, showArt, onPlay, onLike, onDownload }: TrackRowProps) {
  const { track } = row;
  const className = [
    s.row,
    row.isCurrent ? s.rowCurrent : '',
    row.unavailable ? s.rowUnavailable : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className}>
      <button type="button" className={s.main} onClick={() => onPlay(row.index)}>
        <span className={row.isCurrent ? `${s.idx} ${s.idxCurrent}` : s.idx}>{row.idx}</span>
        {showArt && (
          <span className={s.thumb}>
            <TrackArt sources={row.artSources} />
          </span>
        )}
        <span className={s.lines}>
          <span className={row.isCurrent ? `${s.title} ${s.titleCurrent}` : s.title}>
            {track.title}
          </span>
          <span className={s.meta}>
            <span className={s.artist}>{track.artist}</span>{' '}
            <span style={{ color: row.genreColor }}>#{track.genre}</span> {row.durLabel}
          </span>
        </span>
      </button>

      {row.locked && <span className={`${s.tag} ${s.tagPro}`}>[pro]</span>}
      {row.cached && <span className={`${s.tag} ${s.tagOff}`}>[off]</span>}
      {row.dlLabel && <span className={`${s.tag} ${s.tagDl}`}>[{row.dlLabel}]</span>}

      <button
        type="button"
        aria-label={row.liked ? 'Descurtir' : 'Curtir'}
        aria-pressed={row.liked}
        className={row.liked ? `${s.action} ${s.actionLiked}` : s.action}
        onClick={() => onLike(track.id)}
      >
        <Heart size={17} weight={row.liked ? 'fill' : 'regular'} />
      </button>

      <button
        type="button"
        aria-label={row.cached ? 'Remover do aparelho' : 'Baixar para offline'}
        className={[
          s.action,
          row.cached ? s.actionCached : '',
          row.dlLabel ? s.actionDownloading : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => onDownload(row)}
      >
        {row.cached ? (
          <CheckCircle size={17} weight="fill" />
        ) : (
          <DownloadSimple size={17} />
        )}
      </button>
    </div>
  );
}
