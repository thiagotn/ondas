import { useEffect } from 'react';
import * as controller from '../app/controller';
import { compartilhar } from '../platform/share';
import type { RowModel } from '../hooks/useTrackRows';
import { useWide } from '../hooks/useWide';
import { useUi } from '../app/stores';
import s from './shell.module.css';
import { SelectionBar } from './SelectionBar';
import { TrackRow } from './TrackRow';

export interface TrackListProps {
  rows: RowModel[];
  /** Texto de lista vazia da aba atual. */
  emptyText: string;
  loading: boolean;
  /** A playlist aberta, quando a lista é a de uma (ver `SelectionBar`). */
  playlistID?: string;
}

export function TrackList({ rows, emptyText, loading, playlistID }: TrackListProps) {
  const wide = useWide();
  const selecionando = useUi((st) => st.selecionando);

  // `j`/`k` andam pelo que está na tela, e isto é o único lugar que sabe o que
  // está na tela: `controller.tracks` é a lista completa, e em `--curtidas` ou
  // na busca o recorte é um filtro esparso dela. Mesmo padrão do `setTracks`
  // no `AppLayout`, um nível abaixo.
  useEffect(() => {
    controller.setVisible(rows.map((r) => r.track.id));
  }, [rows]);

  if (loading) return <div className={s.loading}>⠋ carregando metadados…</div>;

  // A barra fica FORA do `if` de lista vazia, e dentro de uma playlist isso
  // importa: é por ela que se sai do modo de seleção, e uma playlist cujas
  // faixas saíram do catálogo mostra o texto de vazio — sem a barra ali, o modo
  // ligado não teria porta de saída na tela.
  const barra = <SelectionBar {...(playlistID ? { playlistID } : {})} />;

  if (!rows.length) {
    return (
      <>
        {barra}
        <div className={s.empty}>{emptyText}</div>
      </>
    );
  }

  return (
    <>
      {barra}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {rows.map((row) => (
          <TrackRow
            key={row.track.id}
            row={row}
            showArt={wide}
            showShare={wide}
            compact={!wide}
            selecionando={selecionando}
            onPlay={(index) => void controller.play(index)}
            onCursor={controller.marcarCursor}
            onLike={controller.toggleLike}
            onDownload={(r) => void controller.download(r.track)}
            onShare={(r) => void compartilhar(r.track)}
            onMark={controller.marcar}
          />
        ))}
      </div>
    </>
  );
}
