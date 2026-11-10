import {
  defaultLibrarySegment,
  emptyText,
  hiddenInSegment,
  LIBRARY_SEGMENTS,
  librarySegmentChip,
  parseLibrarySegment,
  promptLine,
  showsPublicCatalog,
  visibleTracks,
  whoAmI,
} from '@ondas/core';
import { t } from '@ondas/core';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as controller from '../app/controller';
import { useLibrary, useSession } from '../app/stores';
import { PlaylistIndex } from '../components/PlaylistIndex';
import { SelectionBar } from '../components/SelectionBar';
import { TabScaffold } from '../components/TabScaffold';
import { UploadPanel } from '../components/UploadPanel';
import { TrackList } from '../components/TrackList';
import { useTrackRows } from '../hooks/useTrackRows';
import { useCatalog } from '../query/catalog';
import { useHistorico } from '../query/historico';
import p from '../components/playlist.module.css';
import s from '../components/shell.module.css';
import { librarySegPath } from './paths';

/**
 * `~/biblioteca`: envio para o acervo, os seis segmentos e a lista.
 *
 * O segmento é o path (`/library/offline`), e não estado de tela: assim cada
 * recorte é linkável, sobrevive a um reload e o voltar anda entre eles.
 * `/library` sem segmento vale `--acervo` com conta e `--curtidas` sem ela
 * (`defaultLibrarySegment`), e um segmento desconhecido cai no mesmo padrão em
 * vez de dar tela de erro.
 *
 * `--playlists` é o único recorte com DOIS estados, e os dois são esta rota: sem
 * id é o índice das playlists (que não lista faixas), com id são as faixas
 * daquela playlist. A diferença mora no path, como tudo o mais aqui.
 */
export function LibraryRoute() {
  const { data, isLoading } = useCatalog();
  const navigate = useNavigate();
  const user = useSession((st) => st.user);
  // O padrão depende da sessão, então ele é lido DEPOIS do usuário: sem conta,
  // abrir em `--acervo` marcaria um chip que a linha abaixo nem desenha.
  const { seg: segParam, id } = useParams();
  // Com id na rota o recorte é `playlists` por construção — o path dela é
  // `/library/playlists/<id>`, e `segParam` já traz a palavra certa. Ler os
  // dois do mesmo lugar é o que impede o chip de discordar do conteúdo.
  const seg = parseLibrarySegment(segParam, defaultLibrarySegment(user));
  const liked = useLibrary((st) => st.liked);
  const cached = useLibrary((st) => st.cached);
  const playlists = useLibrary((st) => st.playlists);

  // A consulta roda em qualquer recorte (com conta): é o que faz `--historico`
  // abrir já desenhado, do cache, em vez de piscar "carregando" a cada visita.
  const historico = useHistorico();

  const aberta = seg === 'playlists' && id ? playlists.find((pl) => pl.id === id) : undefined;
  const tracks = data?.tracks ?? [];
  const visible = useMemo(
    () =>
      visibleTracks({
        tracks,
        tab: 'library',
        q: '',
        genre: 'tudo',
        seg,
        liked,
        cached,
        ...(aberta ? { playlist: aberta.itens } : {}),
        ...(historico.data ? { historico: historico.data } : {}),
      }),
    [tracks, seg, liked, cached, aberta, historico.data],
  );
  const rows = useTrackRows(visible, tracks);

  // Com o catálogo público desligado, faixa pública curtida ou baixada sai da
  // lista — a marca e os bytes ficam, só a linha não aparece. `hidden` é o que
  // deixa o texto de vazio dizer isso em vez de mandar baixar o que já está no
  // aparelho.
  //
  // Na playlist ele é calculado SEMPRE, e não só com o catálogo desligado: ali
  // a faixa pode faltar porque saiu do trending, e isso acontece com o catálogo
  // ligado — é o caso que o prompt e o texto de vazio precisam confessar.
  const publicOff = !showsPublicCatalog(user);
  const hidden = useMemo(
    () =>
      publicOff || aberta
        ? hiddenInSegment(seg, { liked, cached, ...(aberta ? { playlist: aberta.itens } : {}) }, tracks)
        : 0,
    [publicOff, aberta, seg, liked, cached, tracks],
  );

  // O índice das playlists conta playlists; a playlist aberta conta as linhas
  // que ela mostra.
  //
  // `!aberta` e não `!id`: um id que não é playlist nenhuma (link velho,
  // playlist apagada noutro aparelho) cai no índice em vez de virar tela morta
  // — é o mesmo tratamento que `parseLibrarySegment` dá a um recorte que não
  // existe, e pela mesma razão: endereço errado não é falha a explicar.
  const noIndice = seg === 'playlists' && !aberta;
  const line = promptLine({
    tab: 'library',
    who: whoAmI(user),
    genre: 'tudo',
    q: '',
    seg,
    count: noIndice ? playlists.length : visible.length,
    source: data?.source ?? '',
    ...(aberta ? { playlistNome: aberta.nome, fora: hidden } : {}),
  });

  return (
    <TabScaffold line={line}>
      {/* Conta, buffer e ocupação saíram daqui: nenhum deles é biblioteca, e
          os três juntos empurravam a primeira faixa para o meio da tela do
          celular. Agora moram em `ondas whoami` (o nome no prompt, ou o do
          rodapé). Enviar fica: é trabalho de acervo, e acervo é conteúdo. */}
      {/* Enviar arquivo só faz sentido com conta: o acervo é por usuário. E
          dentro de uma playlist ele não é o assunto — ali o que se faz é
          organizar o que já existe. */}
      {/* Nem no histórico, pela mesma razão: ele é registro do que se ouviu, e
          o painel de envio empurraria a primeira linha para baixo à toa. */}
      {user && seg !== 'playlists' && seg !== 'history' && <UploadPanel />}
      {/* `--acervo`, `--compartilhadas` e `--playlists` só com conta, pela mesma
          razão do painel de envio: sem sessão o catálogo não traz faixa do
          acervo nenhuma e playlist é da conta, então os chips seriam listas
          sempre vazias. Quem sai da conta com um deles escolhido cai no texto de
          vazio que explica o login (ver `emptyText`). */}
      <div className={s.segments}>
        {LIBRARY_SEGMENTS.filter(
          (it) =>
            (it !== 'acervo' && it !== 'shared' && it !== 'playlists' && it !== 'history') || user,
        ).map((it) => (
          <button
            key={it}
            type="button"
            aria-pressed={seg === it}
            className={seg === it ? `${s.segment} ${s.segmentActive}` : s.segment}
            onClick={() => navigate(librarySegPath(it))}
          >
            {'--' + librarySegmentChip(it)}
          </button>
        ))}
      </div>

      {noIndice ? (
        <>
          {/* A barra aqui é a MESMA do `TrackList`, e é o que torna o índice
              útil sem faixa nenhuma na tela: marque faixas em `--acervo`, venha
              para cá e a playlist nova nasce com elas dentro. */}
          <SelectionBar />
          {playlists.length ? (
            <PlaylistIndex playlists={playlists} />
          ) : (
            <div className={s.empty}>
              {emptyText({ tab: 'library', seg, q: '', loading: false, user })}
            </div>
          )}
        </>
      ) : (
        <>
          {seg === 'history' && user && visible.length > 0 && <LimparHistorico />}
          <TrackList
            rows={rows}
            // O histórico não depende do catálogo para desenhar: as linhas saem
            // do retrato. O que ele espera é a própria consulta.
            loading={seg === 'history' && user ? historico.isLoading : isLoading}
            {...(aberta ? { playlistID: aberta.id } : {})}
            emptyText={emptyText({
              tab: 'library',
              seg,
              q: '',
              loading: isLoading,
              user,
              publicOff,
              hidden,
              ...(aberta ? { playlistAberta: true } : {}),
            })}
          />
        </>
      )}
    </TabScaffold>
  );
}

/**
 * `[limpar histórico]`, com dois toques — como o `[apagar]` de uma playlist e
 * o `[limpar downloads]` da conta: não dá para desfazer, e a caixa nativa do
 * navegador destoaria.
 *
 * Só aparece com o que limpar. O marcador (onde a conta parou) NÃO é apagado
 * por aqui: "esquecer o que ouvi" não é "perder onde parei".
 */
function LimparHistorico() {
  const [confirmando, setConfirmando] = useState(false);
  return (
    <div className={p.item}>
      {confirmando ? (
        <>
          <span className={p.contador}>{t('historico.limparPergunta')}</span>
          <button
            type="button"
            className={`${p.acao} ${p.acaoRisco}`}
            onClick={() => {
              setConfirmando(false);
              void controller.limparHistorico();
            }}
          >
            {t('ui.sim')}
          </button>
          <button type="button" className={p.acao} onClick={() => setConfirmando(false)}>
            {t('ui.nao')}
          </button>
        </>
      ) : (
        <button type="button" className={p.acao} onClick={() => setConfirmando(true)}>
          {t('historico.limpar')}
        </button>
      )}
    </div>
  );
}
