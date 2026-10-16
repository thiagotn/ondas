import { useEffect } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { bootstrap } from './app/controller';
import { hydrate } from './app/hydrate';
import { useSplash } from './app/splash';
import { useUi } from './app/stores';
import { Splash } from './components/Splash';
import { ThemePicker } from './components/ThemePicker';
import { AppLayout } from './routes/AppLayout';
import { HomeRoute } from './routes/HomeRoute';
import { LibraryRoute } from './routes/LibraryRoute';
import { LoginRoute } from './routes/LoginRoute';
import { SearchRoute } from './routes/SearchRoute';
import { applyTheme } from './theme/applyTheme';

export function App() {
  const themeId = useUi((s) => s.themeId);
  const pickerOpen = useUi((s) => s.pickerOpen);
  const splash = useSplash((s) => s.visible);
  const splashRun = useSplash((s) => s.run);

  // Tokens completos do tema (o script do index.html só aplica o essencial).
  useEffect(() => {
    applyTheme(themeId);
  }, [themeId]);

  useEffect(() => {
    void hydrate();
    return bootstrap();
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        {/* O picker também existe no login, que fica fora do AppLayout. */}
        <Route path="/login" element={<LoginRoute />} />
        <Route element={<AppLayout />}>
          <Route path="/" element={<HomeRoute />} />
          <Route path="/buscar" element={<SearchRoute />} />
          <Route path="/biblioteca" element={<LibraryRoute />} />
          <Route path="*" element={<HomeRoute />} />
        </Route>
      </Routes>
      {/* O picker vale para o app e para o login, que fica fora do AppLayout. */}
      {pickerOpen && <ThemePicker />}
      {/* `key` reinicia o cronômetro quando a abertura é reexibida. */}
      {splash && <Splash key={splashRun} />}
    </BrowserRouter>
  );
}
