import { THEMES } from '@ondas/core';
import * as controller from '../app/controller';
import { uiStore, useUi } from '../app/stores';
import { applyTheme } from '../theme/applyTheme';
import s from './overlay.module.css';

/**
 * `ondas +list-themes`. O tema sob o cursor é aplicado de verdade (pré-visualização
 * ao vivo); sair do painel ou apertar Esc devolve o tema salvo.
 */
export function ThemePicker() {
  const themeId = useUi((st) => st.themeId);
  const pickIdx = useUi((st) => st.pickIdx);

  const restore = () => applyTheme(themeId);
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
                applyTheme(theme.id);
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
          <div className={s.pickerFooter}>
            j/k navegar · enter aplicar · esc fechar · passe o mouse para pré-visualizar
          </div>
        </div>
      </div>
    </div>
  );
}
