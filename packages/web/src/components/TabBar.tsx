import { BANDEIRAS, idioma, t as traduzir, themeIndex } from '@ondas/core';
import { Disc, Flame, MagnifyingGlass, Palette } from '@phosphor-icons/react';
import { uiStore, usePlayer, useUi } from '../app/stores';
import { useAboutOverlay } from '../hooks/useAboutOverlay';
import { useCurrentTrack } from '../hooks/useCurrentTrack';
import { useTabNavigation } from '../hooks/useTabNavigation';
import { useWide } from '../hooks/useWide';
import { CassetteLogo } from './CassetteLogo';
import s from './shell.module.css';

// O rótulo é CHAVE, e não a palavra: ele é o mesmo caminho que o prompt
// escreve (`cwd`), e os dois têm de dizer a mesma coisa nos três idiomas.
const TABS = [
  { id: 'home', chave: 'cwd.home', Icone: Flame },
  { id: 'search', chave: 'cwd.search', Icone: MagnifyingGlass },
  { id: 'library', chave: 'cwd.library', Icone: Disc },
] as const;

/** Barra superior: logo, abas e o botão de tema. */
export function TabBar() {
  const wide = useWide();
  const { tab, goToTab } = useTabNavigation();
  const themeId = useUi((st) => st.themeId);

  return (
    <div className={wide ? s.tabbar : `${s.tabbar} ${s.tabbarNarrow}`}>
      <div className={s.tabbarInner}>
        <TabLogo />
        {TABS.map(({ id, chave, Icone }, i) => {
          const label = traduzir(chave);
          return (
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
          );
        })}
        {/* No estreito as abas tomam a barra inteira. O espaçador tem o mesmo
            `flex: 1` delas, então ficaria com um quarto da sobra — uma quarta
            coluna vazia entre a última aba e o tema. */}
        {wide && <span className={s.spacer} />}
        <button
          type="button"
          title={traduzir('barra.idioma')}
          aria-label={traduzir('barra.trocarIdioma')}
          className={s.palette}
          onClick={() => uiStore.getState().abrirIdiomas()}
        >
          {/* A bandeira é decoração: o botão já se anuncia pelo `aria-label`,
              e no largo a tag do idioma está escrita ao lado. */}
          <span className={s.bandeira} aria-hidden="true">
            {BANDEIRAS[idioma()]}
          </span>
          {wide && idioma()}
        </button>
        <button
          type="button"
          title={traduzir('barra.tema')}
          aria-label={traduzir('barra.trocarTema')}
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

/** O logo da barra: acompanha o player e abre a janela do sobre ao ser clicado. */
function TabLogo() {
  const { openAbout } = useAboutOverlay();
  const { t, dur, playing } = usePlayer((st) => st);
  const track = useCurrentTrack();
  const duration = dur || track?.dur || 0;

  return (
    <button
      type="button"
      className={s.logo}
      title={traduzir('barra.sobre')}
      aria-label={traduzir('barra.sobre')}
      onClick={openAbout}
    >
      <span className={s.logoMark}>
        <CassetteLogo playing={playing} progress={duration ? t / duration : 0} />
      </span>
    </button>
  );
}
