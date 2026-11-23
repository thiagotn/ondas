import { DEFAULT_THEME_ID, findTheme, themeCssVars } from '@ondas/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import { App } from './App';
import './estilo.css';

// Os mesmos tokens da PWA, do mesmo lugar (`themeCssVars`, no core): o painel
// tem a cara do app sem copiar uma paleta. Um tema só — aqui não há o que
// personalizar.
const raiz = document.documentElement;
for (const [chave, valor] of Object.entries(themeCssVars(findTheme(DEFAULT_THEME_ID)))) {
  raiz.style.setProperty(chave, valor);
}
raiz.style.colorScheme = 'dark';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
