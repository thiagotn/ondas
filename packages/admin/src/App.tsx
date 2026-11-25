import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
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
  { para: '/accounts', chave: 'aba.contas', fim: false },
  { para: '/tracks', chave: 'aba.faixas', fim: false },
  { para: '/ingestions', chave: 'aba.ingestoes', fim: false },
  { para: '/signup', chave: 'aba.cadastro', fim: false },
  { para: '/plans', chave: 'aba.planos', fim: false },
  { para: '/history', chave: 'aba.historico', fim: false },
] as const;

const ANTIGOS = {
  contas: 'accounts',
  faixas: 'tracks',
  ingestoes: 'ingestions',
  cadastro: 'signup',
  planos: 'plans',
  historico: 'history',
} as const;

function Antigo({ de, para }: { de: string; para: string }) {
  const { pathname, search } = useLocation();
  return <Navigate to={`/${para}${pathname.slice(de.length + 1)}${search}`} replace />;
}

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
          <Route path="/accounts" element={<Contas />} />
          <Route path="/accounts/:id" element={<ContaDetalhe />} />
          <Route path="/tracks" element={<Faixas />} />
          <Route path="/ingestions" element={<Ingestoes />} />
          <Route path="/signup" element={<Cadastro />} />
          <Route path="/plans" element={<Planos />} />
          <Route path="/history" element={<Historico />} />
          {/* Os endereços antigos, em português: quem guardou um continua
              chegando à mesma tela, com o recorte (`?status=`, `?ord=`) junto. */}
          {Object.entries(ANTIGOS).map(([de, para]) => (
            <Route key={de} path={`/${de}/*`} element={<Antigo de={de} para={para} />} />
          ))}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <footer className="rodape mudo">ondas admin {__APP_VERSION__}</footer>
    </div>
  );
}
