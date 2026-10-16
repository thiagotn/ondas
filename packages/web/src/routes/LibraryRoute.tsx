import { emptyText, promptLine, visibleTracks, whoAmI, type LibrarySegment } from '@ondas/core';
import { useMemo } from 'react';
import { uiStore, useLibrary, useSession, useUi } from '../app/stores';
import { LibraryPanel } from '../components/LibraryPanel';
import { TabScaffold } from '../components/TabScaffold';
import { TrackList } from '../components/TrackList';
import { useTrackRows } from '../hooks/useTrackRows';
import { useCatalog } from '../query/catalog';
import s from '../components/shell.module.css';

const SEGMENTS: [LibrarySegment, string][] = [
  ['liked', '--curtidas'],
  ['offline', '--offline'],
];

/** `~/biblioteca`: conta, buffer, uso de disco e os dois segmentos. */
export function LibraryRoute() {
  const { data, isLoading } = useCatalog();
  const seg = useUi((st) => st.seg);
  const user = useSession((st) => st.user);
  const liked = useLibrary((st) => st.liked);
  const cached = useLibrary((st) => st.cached);

  const tracks = data?.tracks ?? [];
  const visible = useMemo(
    () => visibleTracks({ tracks, tab: 'library', q: '', genre: 'tudo', seg, liked, cached }),
    [tracks, seg, liked, cached],
  );
  const rows = useTrackRows(visible, tracks);

  const line = promptLine({
    tab: 'library',
    who: whoAmI(user),
    genre: 'tudo',
    q: '',
    seg,
    count: visible.length,
    source: data?.source ?? '',
  });

  return (
    <TabScaffold line={line}>
      <LibraryPanel />
      <div className={s.segments}>
        {SEGMENTS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={seg === id}
            className={seg === id ? `${s.segment} ${s.segmentActive}` : s.segment}
            onClick={() => uiStore.getState().setSeg(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <TrackList
        rows={rows}
        loading={isLoading}
        emptyText={emptyText({ tab: 'library', seg, q: '', loading: isLoading, user })}
      />
    </TabScaffold>
  );
}
