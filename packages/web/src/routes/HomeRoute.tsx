import {
  emptyText,
  genreOptions,
  promptLine,
  showsPublicCatalog,
  visibleTracks,
  whoAmI,
} from '@ondas/core';
import { useMemo } from 'react';
import { useLibrary, useSession } from '../app/stores';
import { GenreChips } from '../components/GenreChips';
import { TabScaffold } from '../components/TabScaffold';
import { TrackList } from '../components/TrackList';
import { useQueryParam } from '../hooks/useQueryParam';
import { useTrackRows } from '../hooks/useTrackRows';
import { useCatalog } from '../query/catalog';
import { GENRE_PARAM } from './paths';

/** `~/em-alta`: trending filtrado por gênero. */
export function HomeRoute() {
  const { data, isLoading, isFetching } = useCatalog();
  const [genre, setGenre] = useQueryParam(GENRE_PARAM, 'tudo', 'push');
  const user = useSession((s) => s.user);
  const liked = useLibrary((s) => s.liked);
  const cached = useLibrary((s) => s.cached);

  const tracks = data?.tracks ?? [];
  const visible = useMemo(
    () => visibleTracks({ tracks, tab: 'home', q: '', genre, seg: 'liked', liked, cached }),
    [tracks, genre, liked, cached],
  );
  const rows = useTrackRows(visible, tracks);

  const line = promptLine({
    tab: 'home',
    who: whoAmI(user),
    genre,
    q: '',
    seg: 'liked',
    count: visible.length,
    source: data?.source ?? '',
    // Quando o acervo entra, a fonte deixa de ser uma só: dizer apenas
    // "audius" esconderia metade da lista.
    ...(data?.acervo ? { acervo: data.acervo } : {}),
    // Com cache persistido, o 1º paint é a lista da sessão anterior.
    refreshing: isFetching && !isLoading,
  });

  return (
    <TabScaffold line={line}>
      <GenreChips options={genreOptions(tracks)} value={genre} onChange={setGenre} />
      <TrackList
        rows={rows}
        loading={isLoading}
        emptyText={emptyText({
          tab: 'home',
          seg: 'liked',
          q: '',
          loading: isLoading,
          user,
          publicOff: !showsPublicCatalog(user),
        })}
      />
    </TabScaffold>
  );
}
