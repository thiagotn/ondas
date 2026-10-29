import { emptyText, promptLine, visibleTracks, whoAmI } from '@ondas/core';
import { useMemo } from 'react';
import { useLibrary, useSession } from '../app/stores';
import { SearchBox } from '../components/SearchBox';
import { TabScaffold } from '../components/TabScaffold';
import { TrackList } from '../components/TrackList';
import { searchInputRef } from '../hooks/searchInputRef';
import { useQueryParam } from '../hooks/useQueryParam';
import { useTrackRows } from '../hooks/useTrackRows';
import { useCatalog } from '../query/catalog';
import { SEARCH_PARAM } from './paths';

/** `~/buscar`: filtro local por título, artista ou #gênero. */
export function SearchRoute() {
  const { data, isLoading } = useCatalog();
  const [q, setQ] = useQueryParam(SEARCH_PARAM, '', 'replace');
  const user = useSession((s) => s.user);
  const liked = useLibrary((s) => s.liked);
  const cached = useLibrary((s) => s.cached);

  const tracks = data?.tracks ?? [];
  const visible = useMemo(
    () => visibleTracks({ tracks, tab: 'search', q, genre: 'tudo', seg: 'liked', liked, cached }),
    [tracks, q, liked, cached],
  );
  const rows = useTrackRows(visible, tracks);

  const line = promptLine({
    tab: 'search',
    who: whoAmI(user),
    genre: 'tudo',
    q,
    seg: 'liked',
    count: visible.length,
    source: data?.source ?? '',
  });

  return (
    <TabScaffold line={line}>
      <SearchBox
        ref={searchInputRef}
        value={q}
        count={q ? String(visible.length) : ''}
        onChange={setQ}
      />
      <TrackList
        rows={rows}
        loading={isLoading}
        emptyText={emptyText({ tab: 'search', seg: 'liked', q, loading: isLoading, user })}
      />
    </TabScaffold>
  );
}
