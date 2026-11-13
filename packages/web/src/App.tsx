import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { idioma } from '@ondas/core';
import { prefixoDe } from './app/idioma';
import { bootstrap } from './app/controller';
import { hydrate } from './app/hydrate';
import { useSplash } from './app/splash';
import { useUi } from './app/stores';
import { Splash } from './components/Splash';
import { LangPicker } from './components/LangPicker';
import { ThemePicker } from './components/ThemePicker';
import { Wallpaper } from './components/Wallpaper';
import { AppLayout } from './routes/AppLayout';
import { ChangelogRoute } from './routes/ChangelogRoute';
import { HomeRoute } from './routes/HomeRoute';
import { LibraryRoute } from './routes/LibraryRoute';
import { LoginRoute } from './routes/LoginRoute';
import { SignupRoute } from './routes/SignupRoute';
import { SearchRoute } from './routes/SearchRoute';
import { PATHS } from './routes/paths';
import { TrackRoute } from './routes/TrackRoute';
import { applyTheme } from './theme/applyTheme';

export function App() {
  const themeId = useUi((s) => s.themeId);
  const pickerOpen = useUi((s) => s.pickerOpen);
  const idiomasAberto = useUi((s) => s.idiomasAberto);
  const opacity = useUi((s) => s.opacity);
  const splash = useSplash((s) => s.visible);

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

  // `basename` e não uma rota `/:lang`: assim TODO path absoluto do app
  // (`paths.ts`, `trackPath`, os `navigate()`) continua valendo sem saber que
  // existe idioma, e `useLocation().pathname` chega já sem o prefixo. Em pt-BR
  // ele é vazio, e nada muda.
  return (
    <BrowserRouter basename={prefixoDe(idioma())}>
      <Wallpaper />
      <Routes>
        {/* O picker também existe no login, que fica fora do AppLayout. */}
        <Route path={PATHS.login} element={<LoginRoute />} />
        {/* Fora do layout como o login: quem pede conta ainda não tem sessão. */}
        <Route path={PATHS.signup} element={<SignupRoute />} />
        <Route element={<AppLayout />}>
          <Route path={PATHS.home} element={<HomeRoute />} />
          <Route path={PATHS.search} element={<SearchRoute />} />
          <Route path={`${PATHS.library}/:seg?`} element={<LibraryRoute />} />
          {/* Uma playlist é um nível abaixo do chip: a MESMA tela desenha o
              índice e a playlist aberta, porque as duas são `--playlists` e a
              diferença é só haver um id.
              O recorte continua sendo `:seg` aqui, e não fixo em `playlists`:
              sem ele, `useParams().seg` viria vazio nesta rota e a tela cairia
              no recorte padrão — com a playlist na URL e `--acervo` na tela.
              Um id sob outro recorte (`/library/offline/xyz`) é endereço
              digitado errado e normaliza em silêncio, como `/library/lixo`. */}
          <Route path={`${PATHS.library}/:seg/:id`} element={<LibraryRoute />} />
          {/* Endereço da faixa: o link que se manda E o player cheio aberto.
              Fica DENTRO do layout porque quem chega por ele precisa do app
              inteiro: abas, rodapé e o player. */}
          <Route path="/t/:link" element={<TrackRoute />} />
          {/* As notas de versão, abertas pela linha da versão em `ondas
              --about`. Dentro do layout como as outras: quem chega por um link
              direto cai no app inteiro, com abas e rodapé, e não numa página
              solta sem saída. */}
          <Route path={PATHS.changelog} element={<ChangelogRoute />} />
          {/* Normaliza em vez de mentir: antes `/qualquer-coisa` desenhava a
              home com o endereço errado na barra — e os paths em português
              ficaram todos aqui. */}
          <Route path="*" element={<Navigate to={PATHS.home} replace />} />
        </Route>
      </Routes>
      {/* O picker vale para o app e para o login, que fica fora do AppLayout. */}
      {pickerOpen && <ThemePicker />}
      {/* Como o de tema, e pela mesma razão: vale no app e no login. */}
      {idiomasAberto && <LangPicker />}
      {splash && <Splash />}
    </BrowserRouter>
  );
}
