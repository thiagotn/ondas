import {
  BLUR_MAX,
  OPACITY_MAX,
  OPACITY_MIN,
  t,
  THEMES,
  wallEfetivo,
  type Chave,
  type WallMode,
} from '@ondas/core';
import type { ChangeEvent } from 'react';
import * as controller from '../app/controller';
import { uiStore, useUi } from '../app/stores';
import { downscaleImage } from '../platform/downscaleImage';
import { applyTheme } from '../theme/applyTheme';
import s from './overlay.module.css';

/**
 * `ondas +list-themes`. O tema sob o cursor é aplicado de verdade (pré-visualização
 * ao vivo); sair do painel ou apertar Esc devolve o tema salvo.
 */
export function ThemePicker() {
  const themeId = useUi((st) => st.themeId);
  const pickIdx = useUi((st) => st.pickIdx);
  const opacity = useUi((st) => st.opacity);

  const restore = () => applyTheme(themeId, opacity);
  const close = () => {
    restore();
    uiStore.getState().closePicker();
  };

  return (
    <div className={`${s.backdrop} ${s.backdropLight}`} onClick={close} role="presentation">
      <div
        className={s.picker}
        role="dialog"
        aria-modal="true"
        aria-label="ondas +list-themes"
        onClick={(e) => e.stopPropagation()}
        onMouseLeave={restore}
      >
        <span className={s.label}>ondas +list-themes</span>
        <div className={s.pickerList}>
          {THEMES.map((theme, i) => (
            <button
              key={theme.id}
              type="button"
              className={i === pickIdx ? `${s.pickerRow} ${s.pickerRowFocused}` : s.pickerRow}
              aria-current={theme.id === themeId ? 'true' : undefined}
              onMouseEnter={() => {
                uiStore.getState().setPickIdx(i);
                applyTheme(theme.id, opacity);
              }}
              onClick={() => controller.setTheme(theme.id)}
            >
              <span className={s.pickerMark}>
                {theme.id === themeId ? '●' : i === pickIdx ? '❯' : ''}
              </span>
              <span className={s.pickerName}>{theme.name}</span>
              <span className={s.swatches} aria-hidden="true">
                <span className={s.swatchBg} style={{ background: theme.bg }} />
                {theme.ansi.map((color, j) => (
                  <span key={j} className={s.swatch} style={{ background: color }} />
                ))}
              </span>
            </button>
          ))}
          <BackgroundControls />
          <div className={s.pickerFooter}>{t('tema.rodape')}</div>
        </div>
      </div>
    </div>
  );
}

/** Rótulos das origens de wallpaper; `imagem` só aparece quando há uma salva. */
const WALLS: [WallMode, Chave][] = [
  ['capa', 'tema.wallCapa'],
  ['imagem', 'tema.wallImagem'],
  ['nenhum', 'tema.wallNenhum'],
];

/** Transparência, desfoque e wallpaper — no rodapé do próprio picker. */
function BackgroundControls() {
  const opacity = useUi((st) => st.opacity);
  const blur = useUi((st) => st.blur);
  const wall = useUi((st) => st.wall);
  const wallImg = useUi((st) => st.wallImg);
  // A conta pode pedir `imagem` num aparelho que não tem imagem — ela não
  // viaja. A tela mostra a capa (`Wallpaper`), e o chip marcado tem de dizer o
  // mesmo: sem isto, nenhum dos chips desenhados ficaria aceso.
  const mostrado = wallEfetivo(wall, wallImg);

  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      uiStore.getState().setWallImage(await downscaleImage(file));
    } catch {
      uiStore.getState().flash(t('toast.falhaLerImagem'));
    }
  };

  return (
    <div className={s.settings}>
      <label className={s.setting}>
        <span className={s.settingLabel}>background-opacity</span>
        <input
          type="range"
          className={s.slider}
          min={OPACITY_MIN}
          max={OPACITY_MAX}
          step={0.01}
          value={opacity}
          onChange={(e) => uiStore.getState().setOpacity(Number(e.target.value))}
        />
        <span className={s.settingValue}>{opacity.toFixed(2)}</span>
      </label>

      {/* Esmaecido quando o fundo está opaco: o desfoque não tem o que desfocar. */}
      <label className={opacity < OPACITY_MAX ? s.setting : `${s.setting} ${s.settingOff}`}>
        <span className={s.settingLabel}>background-blur</span>
        <input
          type="range"
          className={s.slider}
          min={0}
          max={BLUR_MAX}
          step={1}
          value={blur}
          onChange={(e) => uiStore.getState().setBlur(Number(e.target.value))}
        />
        <span className={s.settingValue}>{blur}</span>
      </label>

      <div className={s.setting}>
        <span className={s.settingLabel}>wallpaper</span>
        <span className={s.wallOptions}>
          {/* `t(chave)`, e não a chave: a tabela guarda a CHAVE do catálogo, e
              desenhá-la crua punha `tema.wallCapa` na tela. */}
          {WALLS.filter(([id]) => id !== 'imagem' || wallImg).map(([id, chave]) => (
            <button
              key={id}
              type="button"
              aria-pressed={mostrado === id}
              className={mostrado === id ? `${s.wallOption} ${s.wallOptionOn}` : s.wallOption}
              onClick={() => uiStore.getState().setWall(id)}
            >
              {mostrado === id ? `[${t(chave)}]` : t(chave)}
            </button>
          ))}
          <label className={s.upload}>
            {t('tema.enviarImagem')}
            <input type="file" accept="image/*" onChange={(e) => void upload(e)} />
          </label>
        </span>
      </div>
    </div>
  );
}
