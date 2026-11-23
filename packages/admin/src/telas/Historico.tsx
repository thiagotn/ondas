import { api } from '../api';
import { fmtQuando, rotuloAcao } from '../formato';
import { Estado, useDados } from '../ui';

/** O que foi decidido por aqui (e pela `ondasctl`), do mais recente para trás. */
export function Historico() {
  const { dados, erro, carregando } = useDados(() => api.eventos(), []);

  return (
    <section>
      <h1>histórico</h1>
      <p className="mudo">
        as 200 decisões mais recentes. o token de admin não tem identidade: o que distingue quem fez
        é só o IP.
      </p>
      <Estado
        carregando={carregando}
        erro={erro}
        tem={!!dados}
        vazio={dados?.length === 0 && 'nada registrado ainda.'}
      >
        <div className="rolagem">
          <table>
            <thead>
              <tr>
                <th>quando</th>
                <th>o quê</th>
                <th>detalhe</th>
                <th>ip</th>
              </tr>
            </thead>
            <tbody>
              {dados?.map((e) => (
                <tr key={e.id}>
                  <td className="mudo">{fmtQuando(e.em)}</td>
                  <td>
                    {rotuloAcao(e.acao)} {e.alvoRotulo && <strong>{e.alvoRotulo}</strong>}
                  </td>
                  <td className="mudo">{e.detalhe || '—'}</td>
                  <td className="mudo">{e.ip || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Estado>
    </section>
  );
}
