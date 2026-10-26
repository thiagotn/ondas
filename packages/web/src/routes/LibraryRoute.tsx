import { emptyText, promptLine, visibleTracks, whoAmI, type LibrarySegment } from '@ondas/core';
import { useMemo } from 'react';
import { uiStore, useLibrary, useSession, useUi } from '../app/stores';
import { TabScaffold } from '../components/TabScaffold';
import { UploadPanel } from '../components/UploadPanel';
import { TrackList } from '../components/TrackList';
import { useTrackRows } from '../hooks/useTrackRows';
import { useCatalog } from '../query/catalog';
import s from '../components/shell.module.css';

const SEGMENTS: [LibrarySegment, string][] = [
  ['liked', '--curtidas'],
  ['offline', '--offline'],
  ['acervo', '--acervo'],
];

/** `~/biblioteca`: envio para o acervo, os três segmentos e a lista. */
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
      {/* Conta, buffer e ocupação saíram daqui: nenhum deles é biblioteca, e
          os três juntos empurravam a primeira faixa para o meio da tela do
          celular. Agora moram em `ondas whoami` (o nome no prompt, ou o do
          rodapé). Enviar fica: é trabalho de acervo, e acervo é conteúdo. */}
      {/* Enviar arquivo só faz sentido com conta: o acervo é por usuário. */}
      {user && <UploadPanel />}
      {/* `--acervo` só com conta, pela mesma razão do painel de envio: sem
          sessão o catálogo não traz faixa própria nenhuma, e o chip seria uma
          lista sempre vazia. Quem sai da conta com ele escolhido cai no texto
          de vazio que explica o login (ver `emptyText`). */}
      <div className={s.segments}>
        {SEGMENTS.filter(([id]) => id !== 'acervo' || user).map(([id, label]) => (
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
