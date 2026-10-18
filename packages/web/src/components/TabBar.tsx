import { themeIndex } from '@ondas/core';
import { Disc, Flame, MagnifyingGlass, Palette } from '@phosphor-icons/react';
import { useSplash } from '../app/splash';
import { uiStore, usePlayer, useUi } from '../app/stores';
import { useCurrentTrack } from '../hooks/useCurrentTrack';
import { useTabNavigation } from '../hooks/useTabNavigation';
import { useWide } from '../hooks/useWide';
import { CassetteLogo } from './CassetteLogo';
import s from './shell.module.css';

const TABS = [
  { id: 'home', label: '~/em-alta', Icone: Flame },
  { id: 'search', label: '~/buscar', Icone: MagnifyingGlass },
  { id: 'library', label: '~/biblioteca', Icone: Disc },
] as const;

/** Barra superior da "janela": luzes, abas e o botão de tema. */
export function TabBar() {
  const wide = useWide();
  const { tab, goToTab } = useTabNavigation();
  const themeId = useUi((st) => st.themeId);

  return (
    <div className={wide ? s.tabbar : `${s.tabbar} ${s.tabbarNarrow}`}>
      <div className={s.tabbarInner}>
        {wide && <TrafficLights />}
        <TabLogo />
        {TABS.map(({ id, label, Icone }, i) => (
          <button
            key={id}
            type="button"
            onClick={() => goToTab(id)}
            aria-current={tab === id ? 'page' : undefined}
            // No estreito o rótulo vira ícone, então o nome da aba só existe
            // para o leitor de tela — e é o mesmo que o olho lê no prompt.
            aria-label={wide ? undefined : label}
            className={[s.tab, wide ? '' : s.tabIcone, tab === id ? s.tabActive : '']
              .filter(Boolean)
              .join(' ')}
          >
            {wide ? (
              <>
                <span className={s.tabKey}>{i + 1}</span>
                {label}
              </>
            ) : (
              <Icone size={22} />
            )}
          </button>
        ))}
        {/* No estreito as abas tomam a barra inteira. O espaçador tem o mesmo
            `flex: 1` delas, então ficaria com um quarto da sobra — uma quarta
            coluna vazia entre a última aba e o tema. */}
        {wide && <span className={s.spacer} />}
        <button
          type="button"
          title="Tema (t)"
          aria-label="Trocar tema"
          className={s.palette}
          onClick={() => uiStore.getState().openPicker(themeIndex(themeId))}
        >
          <Palette size={16} />
          {wide && themeId}
        </button>
      </div>
    </div>
  );
}

/** O logo da barra: acompanha o player e reexibe a abertura ao ser clicado. */
function TabLogo() {
  const replay = useSplash((st) => st.replay);
  const { t, dur, playing } = usePlayer((st) => st);
  const track = useCurrentTrack();
  const duration = dur || track?.dur || 0;

  return (
    <button type="button" className={s.logo} title="ondas" aria-label="ondas — rever abertura" onClick={replay}>
      <span className={s.logoMark}>
        <CassetteLogo playing={playing} progress={duration ? t / duration : 0} />
      </span>
    </button>
  );
}

/** Os três pontos do canto, só no wide. */
export function TrafficLights() {
  return (
    <span className={s.lights} aria-hidden="true">
      <span className={s.light} style={{ background: 'var(--ansi-1)' }} />
      <span className={s.light} style={{ background: 'var(--ansi-3)' }} />
      <span className={s.light} style={{ background: 'var(--ansi-2)' }} />
    </span>
  );
}
