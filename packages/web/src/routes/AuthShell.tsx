import { BANDEIRAS, idioma, LOCALES, t, themeIndex } from '@ondas/core';
import { Palette } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { uiStore, useUi } from '../app/stores';
import { CassetteLogo } from '../components/CassetteLogo';
import { TrafficLights } from '../components/TrafficLights';
import s from './login.module.css';

function abrirIdiomas() {
  uiStore.getState().setPickIdx(Math.max(0, LOCALES.indexOf(idioma())));
  uiStore.getState().abrirIdiomas();
}

/**
 * A moldura das telas de fora do app — login e pedido de conta: a barra com
 * idioma e tema, o logo, e as duas teclas que valem nas duas.
 *
 * Era o corpo do `LoginRoute`. Saiu de lá quando o cadastro ganhou tela: as
 * duas ficam fora do `AppLayout`, então nenhuma herda barra nem atalho, e a
 * segunda cópia da barra seria a que esqueceria o seletor de idioma — que
 * precisa ser alcançável justamente aqui, na primeira tela de quem não fala
 * português.
 */
export function AuthShell({
  titulo,
  aoTeclar,
  children,
}: {
  titulo: string;
  /** Teclas próprias da tela (`g`, `c`…). Não é chamada enquanto se digita. */
  aoTeclar?: (tecla: string) => void;
  children: ReactNode;
}) {
  const themeId = useUi((st) => st.themeId);

  return (
    <div
      className={s.screen}
      onKeyDown={(e) => {
        // As teclas soltas não valem enquanto se digita.
        const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
        if (typing) return;
        if (e.key === 't') uiStore.getState().openPicker(themeIndex(themeId));
        // O idioma precisa ser alcançável AQUI: é a primeira tela de quem não
        // fala português, e o `useShortcuts` (onde mora o `8`) só existe
        // dentro do `AppLayout`.
        if (e.key === '8') abrirIdiomas();
        aoTeclar?.(e.key);
      }}
    >
      <div className={s.topbar}>
        <TrafficLights />
        <span className={s.topbarTitle}>{titulo}</span>
        <button
          type="button"
          className={s.palette}
          aria-label={t('barra.trocarIdioma')}
          title={t('barra.idioma')}
          onClick={abrirIdiomas}
        >
          <span className={s.bandeira} aria-hidden="true">
            {BANDEIRAS[idioma()]}
          </span>
          {idioma()}
        </button>
        <button
          type="button"
          className={s.palette}
          aria-label={t('barra.trocarTema')}
          onClick={() => uiStore.getState().openPicker(themeIndex(themeId))}
        >
          <Palette size={15} />
          {themeId}
        </button>
      </div>

      <div className={s.content}>
        <div className={s.lockup}>
          <div className={s.lockupMark}>
            {/* Gira sozinho na abertura da tela, devagar: é vitrine, não player. */}
            <CassetteLogo playing progress={0.3} speed={3} ariaLabel="ondas" />
          </div>
          <div className={s.lockupText}>
            <span className={s.lockupName}>ondas</span>
            <span className={s.lockupSide}>{t('login.ladoA')}</span>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
