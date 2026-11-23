import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, ErroDaApi, ouvirSessaoPerdida } from './api';
import { Cadastro } from './telas/Cadastro';
import { ContaDetalhe } from './telas/Conta';
import { Contas } from './telas/Contas';
import { Entrada } from './telas/Entrada';
import { Faixas } from './telas/Faixas';
import { Historico } from './telas/Historico';
import { Ingestoes } from './telas/Ingestoes';
import { Planos } from './telas/Planos';
import { VisaoGeral } from './telas/VisaoGeral';

type Sessao = 'verificando' | 'fora' | 'dentro' | 'desligado';

const ABAS = [
  { para: '/', rotulo: 'visão geral', fim: true },
  { para: '/contas', rotulo: 'contas', fim: false },
  { para: '/faixas', rotulo: 'faixas', fim: false },
  { para: '/ingestoes', rotulo: 'ingestões', fim: false },
  { para: '/cadastro', rotulo: 'cadastro', fim: false },
  { para: '/planos', rotulo: 'planos', fim: false },
  { para: '/historico', rotulo: 'histórico', fim: false },
] as const;

export function App() {
  const [sessao, setSessao] = useState<Sessao>('verificando');

  useEffect(() => {
    ouvirSessaoPerdida(() => setSessao('fora'));
    api
      .sessao()
      .then(() => setSessao('dentro'))
      .catch((e: unknown) => {
        // 404 é a administração desligada no servidor (sem token configurado):
        // não adianta pedir token nenhum.
        setSessao(e instanceof ErroDaApi && e.status === 404 ? 'desligado' : 'fora');
      });
  }, []);

  if (sessao === 'verificando') return <p className="centro mudo">⠋ ondas admin…</p>;
  if (sessao === 'desligado') {
    return (
      <p className="centro erro">
        a administração está desligada no servidor (sem `ADMIN_TOKEN_SHA256`).
      </p>
    );
  }
  if (sessao === 'fora') return <Entrada aoEntrar={() => setSessao('dentro')} />;

  return (
    <div className="app">
      <header className="topo">
        <span className="marca-app">
          <span className="destaque">ondas</span> admin
        </span>
        <nav className="abas" aria-label="Seções">
          {ABAS.map((a) => (
            <NavLink
              key={a.para}
              to={a.para}
              end={a.fim}
              className={({ isActive }) => (isActive ? 'aba ativa' : 'aba')}
            >
              {a.rotulo}
            </NavLink>
          ))}
        </nav>
        <button
          type="button"
          className="link sair"
          onClick={() => {
            // Sai da tela primeiro: se a rede falhar, o cookie vence sozinho em
            // doze horas, e o que a pessoa pediu já valeu aqui.
            setSessao('fora');
            void api.sair().catch(() => {});
          }}
        >
          [sair]
        </button>
      </header>
      <main className="conteudo">
        <Routes>
          <Route path="/" element={<VisaoGeral />} />
          <Route path="/contas" element={<Contas />} />
          <Route path="/contas/:id" element={<ContaDetalhe />} />
          <Route path="/faixas" element={<Faixas />} />
          <Route path="/ingestoes" element={<Ingestoes />} />
          <Route path="/cadastro" element={<Cadastro />} />
          <Route path="/planos" element={<Planos />} />
          <Route path="/historico" element={<Historico />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <footer className="rodape mudo">ondas admin {__APP_VERSION__}</footer>
    </div>
  );
}
