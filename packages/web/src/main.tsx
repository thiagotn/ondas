import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { iniciarIdioma } from './app/idioma';
import { queryClient, queryPersister } from './query/client';
import './styles/global.css';

// Em dev o SW fica fora do caminho; em produção atualiza sozinho.
if (import.meta.env.PROD) registerSW({ immediate: true });

// Antes de qualquer render: o catálogo e o `<html lang>` têm de estar certos
// no primeiro quadro, senão a tela pisca em português e corrige depois.
const idioma = iniciarIdioma();
document.documentElement.lang = idioma;

const container = document.getElementById('root');
if (!container) throw new Error('#root não encontrado');

createRoot(container).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{ persister: queryPersister, maxAge: 24 * 60 * 60_000 }}
    >
      <App />
    </PersistQueryClientProvider>
  </StrictMode>,
);
