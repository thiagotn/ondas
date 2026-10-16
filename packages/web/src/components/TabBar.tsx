import { themeIndex } from '@ondas/core';
import { Palette } from '@phosphor-icons/react';
import { useSplash } from '../app/splash';
import { uiStore, usePlayer, useUi } from '../app/stores';
import { useCurrentTrack } from '../hooks/useCurrentTrack';
import { useTabNavigation } from '../hooks/useTabNavigation';
import { useWide } from '../hooks/useWide';
import { CassetteLogo } from './CassetteLogo';
import s from './shell.module.css';

const TABS = [
  { id: 'home', label: '~/em-alta' },
  { id: 'search', label: '~/buscar' },
  { id: 'library', label: '~/biblioteca' },
] as const;

/** Barra superior da "janela": luzes, abas e o botão de tema. */
export function TabBar() {
  const wide = useWide();
  const { tab, goToTab } = useTabNavigation();
  const themeId = useUi((st) => st.themeId);

  return (
    <div className={s.tabbar}>
      {wide && <TrafficLights />}
      <TabLogo />
      {TABS.map((t, i) => (
        <button
          key={t.id}
          type="button"
          onClick={() => goToTab(t.id)}
          aria-current={tab === t.id ? 'page' : undefined}
          className={tab === t.id ? `${s.tab} ${s.tabActive}` : s.tab}
        >
          {wide && <span className={s.tabKey}>{i + 1}</span>}
          {t.label}
        </button>
      ))}
      <span className={s.spacer} />
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
