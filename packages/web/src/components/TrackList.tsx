import { useEffect } from 'react';
import * as controller from '../app/controller';
import { compartilhar } from '../platform/share';
import type { RowModel } from '../hooks/useTrackRows';
import { useWide } from '../hooks/useWide';
import s from './shell.module.css';
import { TrackRow } from './TrackRow';

export interface TrackListProps {
  rows: RowModel[];
  /** Texto de lista vazia da aba atual. */
  emptyText: string;
  loading: boolean;
}

export function TrackList({ rows, emptyText, loading }: TrackListProps) {
  const wide = useWide();

  // `j`/`k` andam pelo que está na tela, e isto é o único lugar que sabe o que
  // está na tela: `controller.tracks` é a lista completa, e em `--curtidas` ou
  // na busca o recorte é um filtro esparso dela. Mesmo padrão do `setTracks`
  // no `AppLayout`, um nível abaixo.
  useEffect(() => {
    controller.setVisible(rows.map((r) => r.track.id));
  }, [rows]);

  if (loading) return <div className={s.loading}>⠋ carregando metadados…</div>;
  if (!rows.length) return <div className={s.empty}>{emptyText}</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {rows.map((row) => (
        <TrackRow
          key={row.track.id}
          row={row}
          showArt={wide}
          showShare={wide}
          compact={!wide}
          onPlay={(index) => void controller.play(index)}
          onCursor={controller.marcarCursor}
          onLike={controller.toggleLike}
          onDownload={(r) => void controller.download(r.track)}
          onShare={(r) => void compartilhar(r.track)}
        />
      ))}
    </div>
  );
}
