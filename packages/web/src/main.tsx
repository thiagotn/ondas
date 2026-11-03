import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { Desastre } from './components/Desastre';
import { iniciarIdioma } from './app/idioma';
import { queryClient, queryPersister } from './query/client';
import './styles/global.css';

// Em dev o SW fica fora do caminho; em produção atualiza sozinho.
if (import.meta.env.PROD) registerSW({ immediate: true });

// Antes de qualquer render: o catálogo e o `<html lang>` têm de estar certos
// no primeiro quadro, senão a tela pisca em português e corrige depois.
const { locale, redirecionando } = iniciarIdioma();
document.documentElement.lang = locale;

const container = document.getElementById('root');
if (!container) throw new Error('#root não encontrado');

// Vai navegar para o endereço do idioma: desenhar agora só produziria a janela
// em que o router não casa rota nenhuma. Melhor a tela de abertura do que uma
// tela em branco que não vira nada.
if (!redirecionando) {
  createRoot(container).render(
    <StrictMode>
      <Desastre>
        <PersistQueryClientProvider
          client={queryClient}
          // `buster`: muda quando o FORMATO do que é guardado muda, e descarta o
          // cache inteiro em vez de alimentar código novo com dado velho.
          // `Catalog.source` deixou de ser frase e virou código nesta versão, e
          // sem isto o catálogo de ontem derrubava a tela de quem já usava o app.
          persistOptions={{
            persister: queryPersister,
            maxAge: 24 * 60 * 60_000,
            buster: 'source-codigo-1',
          }}
        >
          <App />
        </PersistQueryClientProvider>
      </Desastre>
    </StrictMode>,
  );
}
