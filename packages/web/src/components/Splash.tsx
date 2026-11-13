import { t } from '@ondas/core';
import { useEffect, useState } from 'react';
import { useSplash } from '../app/splash';
import { useCatalog } from '../query/catalog';
import { WaveLogo } from './WaveLogo';
import s from './splash.module.css';

/** Um quadro por tick, como no protótipo. */
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const TICK = 80;
/** Tempo mínimo em tela: abaixo disso a abertura vira um flash. */
const MIN_MS = 2200;
/** Teto: metadados lentos não podem prender o usuário na abertura. */
const CAP_MS = 4500;
const BAR = 20;

/**
 * Abertura: o sol nascendo atrás da onda enquanto o catálogo carrega.
 *
 * Fecha quando já passou o mínimo **e** o catálogo chegou, ou no teto — o que
 * vier primeiro. Um toque pula.
 */
export function Splash() {
  const [elapsed, setElapsed] = useState(0);
  const close = useSplash((st) => st.close);
  // `data` indefinido = catálogo ainda não resolvido (nem da API, nem do cache).
  const { data } = useCatalog();
  const loading = data === undefined;

  useEffect(() => {
    const id = setInterval(() => setElapsed((ms) => ms + TICK), TICK);
    return () => clearInterval(id);
  }, []);

  const done = (elapsed >= MIN_MS && !loading) || elapsed >= CAP_MS;
  useEffect(() => {
    if (done) close();
  }, [done, close]);

  const progress = Math.min(1, elapsed / MIN_MS);
  const filled = Math.round(progress * BAR);

  return (
    <div
      className={s.splash}
      role="button"
      tabIndex={0}
      aria-label={t('splash.pular')}
      onClick={close}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') close();
      }}
    >
      <div className={s.logo}>
        <WaveLogo playing progress={progress} speed={1.2} />
      </div>

      <div className={s.wordmark}>
        <span className={s.name}>ondas</span>
        <span className={s.tagline}>{t('splash.tagline')}</span>
      </div>

      <div className={s.progress}>
        <span className={s.bar}>
          <span className={s.barFilled}>{'█'.repeat(filled)}</span>
          <span className={s.barRest}>{'░'.repeat(BAR - filled)}</span>
        </span>
        <span role="status">
          <span className={s.spinner}>{SPINNER[Math.floor(elapsed / TICK) % SPINNER.length]}</span>{' '}
          {t(loading ? 'splash.carregando' : 'splash.pronto')}
        </span>
      </div>
    </div>
  );
}
