import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import { App } from './App';
import './estilo.css';
import { iniciarPrefs } from './prefs';

// Tema e idioma ANTES do primeiro render: os tokens vêm do mesmo lugar que os
// da PWA (`themeCssVars`, no core), e o idioma é de módulo — fixado aqui, uma
// vez, ele não muda enquanto a página viver (ver `prefs.ts`).
iniciarPrefs();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
