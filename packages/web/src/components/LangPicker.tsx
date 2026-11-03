import { idioma, LOCALES, NOMES_DE_IDIOMA, t } from '@ondas/core';
import { trocarIdioma } from '../app/idioma';
import { uiStore, useUi } from '../app/stores';
import o from './overlay.module.css';

/**
 * `ondas +list-langs` — a janela de idioma, no molde do seletor de tema.
 *
 * Cada opção aparece NO PRÓPRIO IDIOMA (`tEm`), e não traduzida para o idioma
 * de agora: quem abriu isto porque não entende a tela não encontraria
 * "inglês", encontra "english".
 *
 * Diferente do seletor de tema, aqui não há pré-visualização ao passar o
 * mouse: trocar de idioma navega (ver `trocarIdioma`), e não dá para desfazer
 * com um `onMouseLeave`.
 */
export function LangPicker() {
  const fechar = () => uiStore.getState().fecharIdiomas();
  const atual = idioma();
  // O cursor sai do store, e não de estado local: o teclado (`useShortcuts`)
  // e o mouse precisam mover a MESMA linha. É o mesmo `pickIdx` do seletor de
  // tema porque os dois nunca estão abertos juntos — quem está em cima
  // engole a tecla do outro.
  const cursor = useUi((st) => st.pickIdx);

  return (
    <div className={`${o.backdrop} ${o.backdropLight}`} onClick={fechar} role="presentation">
      <div
        className={o.picker}
        role="dialog"
        aria-modal="true"
        aria-label="ondas +list-langs"
        onClick={(e) => e.stopPropagation()}
      >
        <span className={o.label}>ondas +list-langs</span>
        <div className={o.pickerList}>
          {LOCALES.map((locale, i) => (
            <button
              key={locale}
              type="button"
              className={i === cursor ? `${o.pickerRow} ${o.pickerRowFocused}` : o.pickerRow}
              aria-current={locale === atual ? 'true' : undefined}
              onMouseEnter={() => uiStore.getState().setPickIdx(i)}
              onClick={() => trocarIdioma(locale)}
            >
              <span className={o.pickerMark}>
                {locale === atual ? '●' : i === cursor ? '❯' : ''}
              </span>
              <span className={o.pickerName}>{NOMES_DE_IDIOMA[locale]}</span>
              {/* A tag BCP-47 ao lado do nome: é ela que aparece na URL. */}
              <span className={o.langTag} aria-hidden="true">
                {locale}
              </span>
            </button>
          ))}
          <div className={o.pickerFooter}>{t('idioma.rodape')}</div>
        </div>
      </div>
    </div>
  );
}
