import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, ErroDaApi, ouvirSessaoPerdida } from './api';
import { t } from './i18n';
import { Cadastro } from './telas/Cadastro';
import { ContaDetalhe } from './telas/Conta';
import { Contas } from './telas/Contas';
import { Entrada } from './telas/Entrada';
import { Faixas } from './telas/Faixas';
import { Historico } from './telas/Historico';
import { Ingestoes } from './telas/Ingestoes';
import { Planos } from './telas/Planos';
import { VisaoGeral } from './telas/VisaoGeral';
import { Preferencias } from './ui';

type Sessao = 'verificando' | 'fora' | 'dentro' | 'desligado';

// Chave, e não a frase: este módulo é avaliado antes de o idioma ser decidido.
const ABAS = [
  { para: '/', chave: 'aba.visaoGeral', fim: true },
  { para: '/contas', chave: 'aba.contas', fim: false },
  { para: '/faixas', chave: 'aba.faixas', fim: false },
  { para: '/ingestoes', chave: 'aba.ingestoes', fim: false },
  { para: '/cadastro', chave: 'aba.cadastro', fim: false },
  { para: '/planos', chave: 'aba.planos', fim: false },
  { para: '/historico', chave: 'aba.historico', fim: false },
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

  if (sessao === 'verificando') return <p className="centro mudo">{t('app.carregando')}</p>;
  if (sessao === 'desligado') {
    return <p className="centro erro">{t('app.desligado')}</p>;
  }
  if (sessao === 'fora') return <Entrada aoEntrar={() => setSessao('dentro')} />;

  return (
    <div className="app">
      <header className="topo">
        <span className="marca-app">
          <span className="destaque">ondas</span> admin
        </span>
        <nav className="abas" aria-label={t('app.secoes')}>
          {ABAS.map((a) => (
            <NavLink
              key={a.para}
              to={a.para}
              end={a.fim}
              className={({ isActive }) => (isActive ? 'aba ativa' : 'aba')}
            >
              {t(a.chave)}
            </NavLink>
          ))}
        </nav>
        <Preferencias />
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
          {t('app.sair')}
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
