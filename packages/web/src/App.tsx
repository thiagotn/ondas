import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { bootstrap } from './app/controller';
import { hydrate } from './app/hydrate';
import { useSplash } from './app/splash';
import { useUi } from './app/stores';
import { Splash } from './components/Splash';
import { ThemePicker } from './components/ThemePicker';
import { Wallpaper } from './components/Wallpaper';
import { AppLayout } from './routes/AppLayout';
import { HomeRoute } from './routes/HomeRoute';
import { LibraryRoute } from './routes/LibraryRoute';
import { LoginRoute } from './routes/LoginRoute';
import { SearchRoute } from './routes/SearchRoute';
import { PATHS } from './routes/paths';
import { TrackRoute } from './routes/TrackRoute';
import { applyTheme } from './theme/applyTheme';

export function App() {
  const themeId = useUi((s) => s.themeId);
  const pickerOpen = useUi((s) => s.pickerOpen);
  const opacity = useUi((s) => s.opacity);
  const splash = useSplash((s) => s.visible);
  const splashRun = useSplash((s) => s.run);

  // Tokens completos do tema (o script do index.html só aplica o essencial).
  // A opacidade entra aqui porque muda os tokens `-a`: mexer no slider
  // re-aplica o tema inteiro, e trocar de tema preserva a transparência.
  useEffect(() => {
    applyTheme(themeId, opacity);
  }, [themeId, opacity]);

  useEffect(() => {
    void hydrate();
    return bootstrap();
  }, []);

  return (
    <BrowserRouter>
      <Wallpaper />
      <Routes>
        {/* O picker também existe no login, que fica fora do AppLayout. */}
        <Route path={PATHS.login} element={<LoginRoute />} />
        <Route element={<AppLayout />}>
          <Route path={PATHS.home} element={<HomeRoute />} />
          <Route path={PATHS.search} element={<SearchRoute />} />
          <Route path={`${PATHS.library}/:seg?`} element={<LibraryRoute />} />
          {/* Endereço da faixa: o link que se manda E o player cheio aberto.
              Fica DENTRO do layout porque quem chega por ele precisa do app
              inteiro: abas, rodapé e o player. */}
          <Route path="/t/:link" element={<TrackRoute />} />
          {/* Normaliza em vez de mentir: antes `/qualquer-coisa` desenhava a
              home com o endereço errado na barra — e os paths em português
              ficaram todos aqui. */}
          <Route path="*" element={<Navigate to={PATHS.home} replace />} />
        </Route>
      </Routes>
      {/* O picker vale para o app e para o login, que fica fora do AppLayout. */}
      {pickerOpen && <ThemePicker />}
      {/* `key` reinicia o cronômetro quando a abertura é reexibida. */}
      {splash && <Splash key={splashRun} />}
    </BrowserRouter>
  );
}
