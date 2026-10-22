import { CheckCircle, DownloadSimple, Heart, ShareNetwork } from '@phosphor-icons/react';
import { useEffect, useRef } from 'react';
import type { RowModel } from '../hooks/useTrackRows';
import s from './row.module.css';
import { TrackArt } from './TrackArt';

export interface TrackRowProps {
  row: RowModel;
  /** Thumbnail só aparece no wide. */
  showArt: boolean;
  /**
   * Compartilhar também só no wide: no estreito três alvos de 44px comem o
   * título da faixa, e lá o caminho é o player cheio, que tem a folha de
   * compartilhamento do sistema.
   */
  showShare: boolean;
  /**
   * Lista enxuta do estreito: some com [meu], [off] e o #acervo. O ✓ verde do
   * botão de download já diz que a faixa está no aparelho, e o filtro/ordem
   * do acervo já diz de quem ela é — os selos só competiam com o título.
   */
  compact: boolean;
  onPlay(index: number): void;
  /** O Tab chegou nesta linha: o cursor da lista vem junto. */
  onCursor(id: string): void;
  onLike(id: string): void;
  onDownload(row: RowModel): void;
  onShare(row: RowModel): void;
}

/** `[01] [capa] titulo / artista #genero m:ss  [pro] [off] [ 42%]  ♥  ↓` */
export function TrackRow({
  row,
  showArt,
  showShare,
  compact,
  onPlay,
  onCursor,
  onLike,
  onDownload,
  onShare,
}: TrackRowProps) {
  const { track } = row;
  const className = [
    s.row,
    row.isCurrent ? s.rowCurrent : '',
    row.isCursor ? s.rowCursor : '',
    row.unavailable ? s.rowUnavailable : '',
  ]
    .filter(Boolean)
    .join(' ');

  // `:08` pode marcar uma linha fora da janela de rolagem, e aí a marca não
  // serviria de nada. `nearest` para `j` descendo não recentralizar a lista a
  // cada tecla.
  const ref = useRef<HTMLDivElement>(null);
  const botao = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!row.isCursor) return;
    ref.current?.scrollIntoView({ block: 'nearest' });

    // O foco anda com o cursor, mas só se já estava na lista. Sem isto o `j`
    // deixava para trás o anel do Tab na linha antiga e a marca do cursor ia
    // sozinha para a nova — duas linhas marcadas, e o Enter obedecia à do
    // anel, que é o botão que o navegador ativa. Quem está fora da lista fica
    // onde está: `:08` marca a faixa com o foco ainda na linha de comando, e
    // roubá-lo fecharia o campo no meio do comando.
    const ativo = document.activeElement;
    if (ativo && ativo !== botao.current && ref.current?.parentElement?.contains(ativo)) {
      botao.current?.focus({ preventScroll: true });
    }
  }, [row.isCursor]);

  return (
    <div ref={ref} className={className} aria-current={row.isCursor ? 'true' : undefined}>
      <button
        ref={botao}
        type="button"
        className={s.main}
        onClick={() => onPlay(row.index)}
        onFocus={(e) => {
          // Só o foco que o teclado desenha arrasta a marca. O clique e o
          // toque também focam o botão, e sem esta pergunta a linha tocada
          // ganharia a barra do cursor sem ninguém ter andado com `j`/`k` —
          // no celular, onde ninguém anda, ela apareceria em toda faixa
          // tocada. É a mesma pergunta que o `:focus-visible` do CSS faz.
          if (e.currentTarget.matches(':focus-visible')) onCursor(track.id);
        }}
      >
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
            {!(compact && row.minha) && (
              <>
                <span style={{ color: row.genreColor }}>#{track.genre}</span>{' '}
              </>
            )}
            {row.durLabel}
          </span>
        </span>
      </button>

      {/* Antes de [pro] e [off]: a origem da faixa é o que o dono procura
          primeiro na linha. [meu] e [pro] nunca aparecem juntos — faixa do
          acervo vem com premium: false e o selo [pro] só existe sem sessão. */}
      {row.minha && !compact && <span className={`${s.tag} ${s.tagMeu}`}>[meu]</span>}
      {row.locked && <span className={`${s.tag} ${s.tagPro}`}>[pro]</span>}
      {row.cached && !compact && <span className={`${s.tag} ${s.tagOff}`}>[off]</span>}
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

      {showShare && (
        <button
          type="button"
          aria-label="Compartilhar"
          className={s.action}
          onClick={() => onShare(row)}
        >
          <ShareNetwork size={17} />
        </button>
      )}
    </div>
  );
}
