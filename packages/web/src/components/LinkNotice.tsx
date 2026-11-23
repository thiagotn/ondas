import { canUpload, rotuloDoLink, t } from '@ondas/core';
import { useLinkSugerido } from '../app/linkSugerido';
import { uiStore, useSession } from '../app/stores';
import { useUploads } from '../app/uploads';
import s from './shell.module.css';

const ROTULO = {
  youtube: 'link.youtube',
  soundcloud: 'link.soundcloud',
  midia: 'link.midia',
} as const;

/**
 * "link do YouTube copiado — [adicionar ao acervo] [ignorar]".
 *
 * O mesmo desenho do aviso de visitante, e a mesma ideia: o app notou uma
 * coisa e diz o que dá para fazer com ela. Só aparece para quem pode enviar, e
 * só mostra o site e o fim do endereço — nunca o resto do que estava no
 * clipboard.
 *
 * Nada sai do aparelho antes do toque em `[adicionar ao acervo]`.
 */
export function LinkNotice() {
  const user = useSession((st) => st.user);
  const link = useLinkSugerido((st) => st.link);
  const origem = useLinkSugerido((st) => st.origem);
  const resolver = useLinkSugerido((st) => st.resolver);
  const adicionarLink = useUploads((st) => st.adicionarLink);

  if (!link || !canUpload(user)) return null;

  return (
    <div className={s.notice} role="status">
      <span className={s.noticeLabel}>
        {origem === 'compartilhado' ? t('link.compartilhado') : t(ROTULO[link.site])}
      </span>
      <span className={s.noticeText}>{rotuloDoLink(link)}</span>
      <button
        type="button"
        className={s.link}
        onClick={() => {
          resolver();
          uiStore.getState().flash(t('link.naFila'));
          void adicionarLink(link);
        }}
      >
        {t('link.adicionar')}
      </button>
      <button type="button" className={s.link} onClick={resolver}>
        {t('link.ignorar')}
      </button>
    </div>
  );
}
