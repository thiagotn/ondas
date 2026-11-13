import { trackPath } from '@ondas/core';
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import * as controller from '../app/controller';
import { compartilhar } from '../platform/share';
import type { RowModel } from '../hooks/useTrackRows';
import { useWide } from '../hooks/useWide';
import { useUi } from '../app/stores';
import { semOverlays } from '../routes/paths';
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
  const navigate = useNavigate();
  const { pathname, search } = useLocation();

  // `j`/`k` andam pelo que está na tela, e isto é o único lugar que sabe o que
  // está na tela: `controller.tracks` é a lista completa, e em `--curtidas` ou
  // na busca o recorte é um filtro esparso dela. Mesmo padrão do `setTracks`
  // no `AppLayout`, um nível abaixo.
  //
  // A limpeza ao desmontar é o que cobre a tela SEM lista: o índice de
  // `--playlists` não monta este componente, e sem ela `visiveis` continuava
  // sendo o recorte de onde se veio — `j` andava por linhas que não estavam na
  // tela.
  useEffect(() => {
    controller.setVisible(rows.map((r) => r.track.id));
    return () => controller.setVisible([]);
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
            selecionando={selecionando}
            onPlay={(index) => void controller.play(index)}
            // A linha de fora do catálogo abre o ENDEREÇO da faixa em vez de
            // tocar no lugar. É o caminho que já existe para "uma faixa que não
            // está na lista": o `TrackRoute` a busca por id, a põe na fila como
            // avulsa e toca — e já sabe dizer que ela não existe mais. O `from`
            // é o do `usePlayerOverlay`, para o fechar do player voltar para cá.
            onOpen={(r) =>
              navigate(trackPath(r.track), { state: { from: semOverlays(pathname + search) } })
            }
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
