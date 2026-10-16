import { useUi } from '../app/stores';
import { useCurrentTrack } from '../hooks/useCurrentTrack';
import { useCatalog } from '../query/catalog';
import s from './wallpaper.module.css';

/**
 * Sem capa à mão, o fundo vira um degradê com as cores ANSI do tema — assim o
 * efeito existe mesmo no catálogo demo, que não tem arte.
 */
const FALLBACK = [
  'radial-gradient(40% 50% at 20% 30%, var(--ansi-5), transparent)',
  'radial-gradient(40% 50% at 80% 70%, var(--ansi-4), transparent)',
  'radial-gradient(30% 40% at 60% 15%, var(--ansi-1), transparent)',
].join(', ');

/**
 * Imagem de fundo atrás do app, no espírito do `background-blur` do Ghostty.
 *
 * O desfoque vai no `filter` desta camada, e **não** num `backdrop-filter` da
 * raiz: `backdrop-filter` cria um containing block e quebraria todo overlay
 * `position: fixed` (full player, gate, picker, abertura).
 */
export function Wallpaper() {
  const opacity = useUi((st) => st.opacity);
  const blur = useUi((st) => st.blur);
  const wall = useUi((st) => st.wall);
  const wallImg = useUi((st) => st.wallImg);
  const current = useCurrentTrack();
  const { data } = useCatalog();

  // Opaco ou desligado: nada é renderizado — custo zero para quem não usa.
  if (opacity >= 1 || wall === 'nenhum') return null;

  const art =
    wall === 'imagem' && wallImg
      ? wallImg
      : (current?.art ?? data?.tracks.find((t) => t.art)?.art);

  return (
    <div
      className={s.wall}
      aria-hidden="true"
      style={{
        backgroundImage: art ? `url("${art}")` : FALLBACK,
        filter: `blur(${blur}px)`,
      }}
    />
  );
}
