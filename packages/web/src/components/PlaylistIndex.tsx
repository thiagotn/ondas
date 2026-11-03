import { t } from '@ondas/core';
import type { Playlist } from '@ondas/core';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as controller from '../app/controller';
import { playlistPath } from '../routes/paths';
import { CampoDeNome } from './SelectionBar';
import s from './playlist.module.css';

/**
 * O índice de `--playlists`: a única tela da biblioteca que não lista faixas.
 *
 * A contagem é de ITENS GUARDADOS, e não de linhas que a playlist mostraria:
 * ela vem do servidor, e faixa pública que saiu do catálogo continua contando
 * aqui. É de propósito — é a playlist que tem 7 faixas, mesmo que hoje só 5
 * apareçam, e quem abre vê a frase que explica (ver `emptyText`).
 */
export function PlaylistIndex({ playlists }: { playlists: readonly Playlist[] }) {
  return (
    <div className={s.lista}>
      {playlists.map((p) => (
        <Linha key={p.id} playlist={p} />
      ))}
    </div>
  );
}

function Linha({ playlist }: { playlist: Playlist }) {
  const navigate = useNavigate();
  const [renomeando, setRenomeando] = useState(false);
  const [confirmando, setConfirmando] = useState(false);

  if (renomeando) {
    return (
      <div className={s.item}>
        <CampoDeNome
          rotulo={t('playlist.novoNome')}
          inicial={playlist.nome}
          onCancelar={() => setRenomeando(false)}
          onPronto={(nome) => {
            setRenomeando(false);
            void controller.renomearPlaylist(playlist.id, nome);
          }}
        />
      </div>
    );
  }

  return (
    <div className={s.item}>
      <button type="button" className={s.abrir} onClick={() => navigate(playlistPath(playlist.id))}>
        <span className={s.marca}>❯</span>
        <span className={s.nome}>{playlist.nome}</span>
        <span className={s.quantas}>{t('playlist.faixas', { n: playlist.itens.length })}</span>
      </button>

      {/* Dois toques para apagar, como o `limpar downloads` do painel de conta:
          não dá para desfazer, e a caixa nativa do navegador destoaria. */}
      {confirmando ? (
        <>
          <span className={s.contador}>{t('playlist.apagar')}</span>
          <button
            type="button"
            className={`${s.acao} ${s.acaoRisco}`}
            onClick={() => {
              setConfirmando(false);
              void controller.apagarPlaylist(playlist.id);
            }}
          >
            {t('ui.sim')}
          </button>
          <button type="button" className={s.acao} onClick={() => setConfirmando(false)}>
            {t('ui.nao')}
          </button>
        </>
      ) : (
        <>
          <button type="button" className={s.acao} onClick={() => setRenomeando(true)}>
            {t('playlist.renomear')}
          </button>
          <button
            type="button"
            className={`${s.acao} ${s.acaoRisco}`}
            onClick={() => setConfirmando(true)}
          >
            {t('playlist.apagarBotao')}
          </button>
        </>
      )}
    </div>
  );
}
