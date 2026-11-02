import { useState } from 'react';
import * as controller from '../app/controller';
import { uiStore, useLibrary, useUi } from '../app/stores';
import { CampoDeNome } from './SelectionBar';
import o from './overlay.module.css';
import s from './playlist.module.css';

/**
 * `ondas +add-to-playlist`: para onde vão as faixas marcadas.
 *
 * No molde do `ThemePicker` — mesmas classes, mesmo `j`/`k`/enter/esc (o
 * teclado é capturado em `useShortcuts` enquanto ele está aberto). O que ele
 * NÃO tem é a pré-visualização ao vivo daquele: aqui a escolha é um ato, não um
 * ajuste, e por isso ela também não desfaz no Esc.
 */
export function PlaylistPicker() {
  const playlists = useLibrary((st) => st.playlists);
  const marcadas = useUi((st) => st.marcadas);
  const idx = useUi((st) => st.seletorIdx);
  const [criando, setCriando] = useState(false);

  const fechar = () => uiStore.getState().fecharSeletorPlaylist();
  const ids = Object.keys(marcadas);

  return (
    <div className={`${o.backdrop} ${o.backdropLight}`} onClick={fechar} role="presentation">
      <div
        className={o.picker}
        role="dialog"
        aria-modal="true"
        aria-label="ondas +add-to-playlist"
        onClick={(e) => e.stopPropagation()}
      >
        <span className={o.label}>
          ondas add {ids.length === 1 ? '1 faixa' : `${ids.length} faixas`} --para
        </span>
        <div className={o.pickerList}>
          {playlists.map((p, i) => {
            // Quantas das marcadas já estão lá. O servidor ignora a repetição
            // (é a PK dos itens), então sem este número adicionar de novo
            // pareceria não ter feito nada.
            const jaTem = ids.filter((id) => p.itens.includes(id)).length;
            return (
              <button
                key={p.id}
                type="button"
                className={i === idx ? `${o.pickerRow} ${o.pickerRowFocused}` : o.pickerRow}
                onMouseEnter={() => uiStore.getState().setSeletorIdx(i)}
                onClick={() => void controller.adicionarMarcadas(p.id)}
              >
                <span className={o.pickerMark}>{i === idx ? '❯' : ''}</span>
                <span className={o.pickerName}>{p.nome}</span>
                <span className={s.jaTem}>
                  {jaTem ? `${jaTem} já está${jaTem > 1 ? 'ão' : ''} aqui` : `${p.itens.length}`}
                </span>
              </button>
            );
          })}

          {criando ? (
            <CampoDeNome
              rotulo="nome da playlist"
              onCancelar={() => setCriando(false)}
              onPronto={(nome) => {
                setCriando(false);
                void controller.criarComMarcadas(nome);
              }}
            />
          ) : (
            <button
              type="button"
              className={o.pickerRow}
              onClick={() => setCriando(true)}
            >
              <span className={o.pickerMark} />
              <span className={o.pickerName}>[nova playlist…]</span>
            </button>
          )}

          <div className={o.pickerFooter}>j/k navegar · enter escolher · esc fechar</div>
        </div>
      </div>
    </div>
  );
}
