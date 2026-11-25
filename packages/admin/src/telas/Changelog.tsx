import { itensDe } from '@ondas/core';
import { t } from '../i18n';
import { RELEASES } from '../release';

/**
 * `/changelog` — o que mudou no painel a cada entrega, aberto pela versão do
 * rodapé. Não é aba: é consulta rara, e a barra já tem sete.
 *
 * A lista é a de `release/notas.json`, a mesma de onde saem a versão do pacote
 * e o `CHANGELOG.md` — não uma segunda cópia para alguém esquecer.
 */
export function Changelog() {
  return (
    <section>
      <h1>{t('changelog.titulo')}</h1>
      <p className="mudo">{t('changelog.explica')}</p>
      {RELEASES.map((r) => (
        <section key={r.versao}>
          <h2>
            v{r.versao} <span className="mudo">{r.data}</span>
            {/* Compara com o bundle que está rodando, e não com o topo da
                lista: numa aba que ficou aberta durante um deploy, o que está
                na tela é a versão antiga. */}
            {r.versao === __APP_VERSION__ && <span className="destaque"> {t('changelog.emUso')}</span>}
          </h2>
          <ul className="notas">
            {itensDe(r).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
