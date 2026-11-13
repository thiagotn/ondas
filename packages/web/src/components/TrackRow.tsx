import { t } from '@ondas/core';
import { CheckCircle, DownloadSimple, Heart, ShareNetwork } from '@phosphor-icons/react';
import { useEffect, useRef } from 'react';
import type { RowModel } from '../hooks/useTrackRows';
import { useToqueLongo } from '../hooks/useToqueLongo';
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
   * Lista enxuta do estreito: some com o `#acervo`, que lá só empurra a
   * duração.
   */
  compact: boolean;
  /**
   * O modo de seleção está ligado: o corpo da linha MARCA em vez de tocar.
   *
   * É o idioma do celular, onde montar uma playlist com um toque por faixa não
   * pode significar tocar uma faixa por toque. Quem quer ouvir antes de
   * adicionar tem o `enter` do teclado, que continua tocando a linha do cursor.
   */
  selecionando: boolean;
  onPlay(index: number): void;
  /** O toque numa linha `fora` do catálogo: não há índice para tocar. */
  onOpen(row: RowModel): void;
  /** O Tab chegou nesta linha: o cursor da lista vem junto. */
  onCursor(id: string): void;
  onLike(id: string): void;
  onDownload(row: RowModel): void;
  onShare(row: RowModel): void;
  onMark(id: string): void;
}

/** `[01] [capa] titulo / artista #genero m:ss  [de nome] [pro] [ 42%]  ♥  ↓` */
export function TrackRow({
  row,
  showArt,
  showShare,
  compact,
  selecionando,
  onPlay,
  onOpen,
  onCursor,
  onLike,
  onDownload,
  onShare,
  onMark,
}: TrackRowProps) {
  const { track } = row;
  const className = [
    s.row,
    row.isCurrent ? s.rowCurrent : '',
    row.isCursor ? s.rowCursor : '',
    row.unavailable ? s.rowUnavailable : '',
    row.fora ? s.rowFora : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Segurar a linha liga a marcação e marca esta faixa — o idioma do celular
  // para seleção múltipla. É a ÚNICA porta no toque: não há botão na tela, por
  // escolha de layout (um `[selecionar]` sozinho custava 64px de altura acima
  // da primeira faixa). No teclado a porta é `v`, e a janela `?` anuncia as duas.
  //
  // Com o modo já ligado, segurar faz o mesmo que tocar: alterna a marca. Não
  // há um segundo gesto a inventar aí.
  const longo = useToqueLongo(() => onMark(track.id));

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
        aria-pressed={selecionando ? row.marcada : undefined}
        {...longo.handlers}
        onClick={() => {
          // O clique que vem no rastro da pressão é engolido: sem isto,
          // segurar marcaria a faixa E a tocaria.
          if (longo.consumiuClique()) return;
          if (selecionando) onMark(track.id);
          else if (row.fora) onOpen(row);
          else onPlay(row.index);
        }}
        onFocus={(e) => {
          // Só o foco que o teclado desenha arrasta a marca. O clique e o
          // toque também focam o botão, e sem esta pergunta a linha tocada
          // ganharia a barra do cursor sem ninguém ter andado com `j`/`k` —
          // no celular, onde ninguém anda, ela apareceria em toda faixa
          // tocada. É a mesma pergunta que o `:focus-visible` do CSS faz.
          if (e.currentTarget.matches(':focus-visible')) onCursor(track.id);
        }}
      >
        {/* A calha vira a caixa de marcação: ela já é a coluna de 3ch à
            esquerda de toda linha, e abrir uma sexta coluna só para a marca
            empurraria o título. O número volta ao sair do modo. */}
        <span className={row.isCurrent ? `${s.idx} ${s.idxCurrent}` : s.idx}>
          {selecionando ? (row.marcada ? '[x]' : '[ ]') : row.idx}
        </span>
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
            {/* Faixa do acervo tem gênero `acervo` sempre (o worker o fixa), e
                na tela estreita `#acervo` é ruído que empurra a duração. Vale
                para a minha e para a compartilhada — as duas vêm do acervo. */}
            {/* E o retrato do histórico não guarda gênero: `#` sozinho seria lixo. */}
            {!!track.genre && !(compact && (row.minha || row.owner)) && (
              <>
                <span style={{ color: row.genreColor }}>#{track.genre}</span>{' '}
              </>
            )}
            {row.durLabel}
          </span>
        </span>
      </button>

      {/* A linha não tem selo para "é minha" nem para "está no aparelho": as
          duas coisas já estão escritas nela. Faixa do acervo sem `[de <nome>]`
          é minha, e o ✓ verde do botão de download nasce da mesma condição
          (`row.cached`) que um `[off]` nasceria. Os dois selos existiram, e só
          repetiam a linha.

          `[de <nome>]` fica, e NA TELA ESTREITA TAMBÉM: é a única marca de que
          a faixa é de outra pessoa, e sem ela a faixa pareceria sua numa lista
          misturada (em-alta e busca), onde o chip do recorte não ajuda. A
          largura existe: a linha do acervo já abre mão do `#acervo` no
          compacto (ver o gênero acima). */}
      {row.owner && (
        <span className={`${s.tag} ${s.tagDe}`}>{t('faixa.de', { dono: row.owner })}</span>
      )}
      {row.locked && <span className={`${s.tag} ${s.tagPro}`}>[pro]</span>}
      {row.dlLabel && <span className={`${s.tag} ${s.tagDl}`}>[{row.dlLabel}]</span>}

      <button
        type="button"
        // Sem sessão o rótulo diz por quê, e o botão continua CLICÁVEL: quem
        // recusa é o `controller`, com uma mensagem na tela. `aria-disabled`
        // aqui seria pior que o silêncio — um coração inerte não explica nada,
        // e nem leitor de tela nem teclado chegariam ao aviso.
        aria-label={rotuloDeCurtir(row)}
        aria-pressed={row.liked}
        className={row.liked ? `${s.action} ${s.actionLiked}` : s.action}
        onClick={() => onLike(track.id)}
      >
        <Heart size={17} weight={row.liked ? 'fill' : 'regular'} />
      </button>

      {/* Linha de fora não baixa nem compartilha daqui: o retrato não tem
          `stream`, e baixar "nada" marcaria um arquivo vazio como guardado no
          aparelho. Quem quer isso abre a faixa — lá ela é resolvida inteira. */}
      {!row.fora && (
        <button
          type="button"
          aria-label={t(row.cached ? 'acao.removerDoAparelho' : 'acao.baixar')}
          className={[
            s.action,
            row.cached ? s.actionCached : '',
            row.dlLabel ? s.actionDownloading : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => onDownload(row)}
        >
          {row.cached ? <CheckCircle size={17} weight="fill" /> : <DownloadSimple size={17} />}
        </button>
      )}

      {showShare && !row.fora && (
        <button
          type="button"
          aria-label={t('player.compartilhar')}
          className={s.action}
          onClick={() => onShare(row)}
        >
          <ShareNetwork size={17} />
        </button>
      )}
    </div>
  );
}

function rotuloDeCurtir(row: RowModel): string {
  if (!row.canLike) return t('acao.curtirExigeConta');
  return t(row.liked ? 'acao.descurtir' : 'acao.curtir');
}
