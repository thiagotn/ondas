import { itensDe, RELEASES, t, whoAmI, type PromptLine } from '@ondas/core';
import { useSession } from '../app/stores';
import c from '../components/changelog.module.css';
import { TabScaffold } from '../components/TabScaffold';

/**
 * `/changelog` — as notas de cada versão, abertas pela linha da versão em
 * `ondas --about`.
 *
 * A lista vem de `RELEASES` (core), o MESMO arquivo de onde `pnpm release` tira
 * a versão dos `package.json` e gera o `CHANGELOG.md` do repositório: a página
 * não é uma segunda cópia da nota que alguém vai esquecer de atualizar.
 *
 * O prompt é montado aqui, à mão, e não por `promptLine`: aquele é indexado por
 * aba, e esta tela não é aba — é o mesmo caminho que `/t/...` já faz para o
 * player cheio.
 */
export function ChangelogRoute() {
  const user = useSession((st) => st.user);

  const line: PromptLine = {
    who: whoAmI(user),
    cwd: t('cwd.changelog'),
    cmd: t('cmd.changelog'),
    comment: t('prompt.changelog', { n: RELEASES.length }),
  };

  return (
    <TabScaffold line={line}>
      <div className={c.lista}>
        {RELEASES.map((release) => (
          <section key={release.versao} className={c.secao}>
            <h2 className={c.cabecalho}>
              <span className={c.versao}>v{release.versao}</span>
              <span className={c.data}>{release.data}</span>
              {/* A comparação é com `__APP_VERSION__`, e não com o topo da
                  lista: numa PWA que ficou aberta durante um deploy, o bundle
                  antigo é quem está rodando, e dizer "em uso" na versão nova
                  seria mentira. */}
              {release.versao === __APP_VERSION__ && (
                <span className={c.atual}>{t('changelog.atual')}</span>
              )}
            </h2>
            <ul className={c.itens}>
              {itensDe(release).map((item) => (
                <li key={item} className={c.item}>
                  {item}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </TabScaffold>
  );
}
