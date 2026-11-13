import { t, tAoRedor } from '@ondas/core';
import { Link } from 'react-router-dom';
import { usePlayer } from '../app/stores';
import { useAboutOverlay } from '../hooks/useAboutOverlay';
import { useCurrentTrack } from '../hooks/useCurrentTrack';
import { useWide } from '../hooks/useWide';
import { PATHS } from '../routes/paths';
import o from './overlay.module.css';
import s from './shell.module.css';
import { WaveLogo } from './WaveLogo';

/** O perfil do autor, atrás do `@thiagotn` que a própria frase já dizia. */
const GITHUB = 'https://github.com/thiagotn';

/**
 * Onde se reporta um bug: o seletor de modelos de issue do repositório. O
 * `/choose` cai no formulário de `.github/ISSUE_TEMPLATE/bug.yml`, que é quem
 * pede versão, passos e aparelho — esta janela só leva até lá.
 */
const ISSUES = 'https://github.com/thiagotn/ondas/issues/new/choose';

/**
 * `ondas --about` — o que o ondas é, e de quem.
 *
 * A quarta janela de referência, no mesmo molde das outras três (`whoami`,
 * `--help`, `+list-themes`): a caixa e o rótulo saem dos mesmos seletores.
 *
 * Duas coisas que estavam aqui saíram: a linha de autor do painel, que repetia
 * o `@thiagotn` da frase acima dela e carregava um `[github]` solto — agora o
 * nome na frase É o link —, e o botão de rever a abertura, que era o último
 * resto de um recurso que já tinha mudado de porta duas vezes. A abertura roda
 * no boot e pronto.
 *
 * O que entrou no lugar: a versão agora leva às notas dela (`/changelog`), que
 * é a resposta à pergunta que o número sozinho não responde.
 */
export function AboutOverlay() {
  const wide = useWide();
  const { closeAbout } = useAboutOverlay();
  const { t: tempo, dur, playing } = usePlayer((st) => st);
  const faixa = useCurrentTrack();
  const duracao = dur || faixa?.dur || 0;
  // A frase chega partida em volta do `{autor}` do catálogo: o nome cai no meio
  // dela, e em espanhol não no mesmo lugar que em português.
  const [antesDoAutor, depoisDoAutor] = tAoRedor('sobre.texto2', 'autor');

  return (
    <div className={o.backdrop} onClick={closeAbout} role="presentation">
      <div
        className={o.sobre}
        role="dialog"
        aria-modal="true"
        aria-label="ondas --about"
        onClick={(e) => e.stopPropagation()}
      >
        <span className={o.label}>ondas --about</span>
        <button type="button" className={o.close} onClick={closeAbout}>
          {t(wide ? 'ui.fecharEsc' : 'ui.fechar')}
        </button>

        <div className={o.sobreCorpo}>
          {/* A marca, viva como a da barra de abas que abriu esta janela: mexe
              com o áudio e o sol acompanha a faixa. Sem faixa nenhuma o sol
              fica alto, e não no mar: aqui a marca é assinatura, e meio sol
              afundado leria como desenho cortado. Decorativa (sem nome
              acessível): o nome do produto já está no rótulo da janela e na
              frase abaixo. */}
          <div className={o.sobreLogo}>
            <WaveLogo playing={playing} progress={duracao ? tempo / duracao : 1} />
          </div>

          <p className={o.sobreTexto}>{t('sobre.texto1')}</p>
          <p className={o.sobreTexto}>
            {antesDoAutor}
            <a className={o.sobreAutor} href={GITHUB} target="_blank" rel="noreferrer">
              @thiagotn
            </a>
            {depoisDoAutor}
          </p>

          <div className={s.panel}>
            <div className={s.panelRow}>
              <span className={s.panelLabel}>{t('sobre.versao')}</span>
              <span className={s.panelValue}>{__APP_VERSION__}</span>
              {/* `replace`: esta janela foi passagem, não lugar. Sem ele, o
                  voltar da página de notas reabriria o sobre (o `?about=1`
                  ainda estaria no histórico) em vez de devolver a tela de onde
                  a pessoa veio. Fechar o overlay à mão não é preciso: a
                  navegação troca o path e o param vai com ele. */}
              <Link className={s.link} to={PATHS.changelog} replace>
                {t('sobre.notas')}
              </Link>
            </div>
            <div className={s.panelRow}>
              <span className={s.panelLabel}>{t('sobre.feitoCom')}</span>
              <span className={s.panelValue}>react · typescript · vite</span>
            </div>
            <div className={s.panelRow}>
              <span className={s.panelLabel}>{t('sobre.bugs')}</span>
              {/* Só o link. O que informar não precisa estar escrito aqui: o
                  formulário da issue já pede cada campo, e a frase que explicava
                  isso ocupava meia tela no celular. O `panelValue` vazio é o
                  que empurra o link para a direita, como na linha da versão. */}
              <span className={s.panelValue} />
              <a className={s.link} href={ISSUES} target="_blank" rel="noreferrer">
                {t('sobre.reportar')}
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
