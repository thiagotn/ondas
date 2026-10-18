import { parseTrackPath } from '@ondas/core';
import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import * as controller from '../app/controller';
import { useGuestMode } from '../app/guest';
import { useSession, useUi } from '../app/stores';
import { BottomBar } from '../components/BottomBar';
import { FullPlayer } from '../components/FullPlayer';
import { Gate } from '../components/Gate';
import { TabBar } from '../components/TabBar';
import s from '../components/shell.module.css';
import { searchInputRef } from '../hooks/searchInputRef';
import { useCurrentTrack } from '../hooks/useCurrentTrack';
import { usePlayerOverlay } from '../hooks/usePlayerOverlay';
import { useShortcuts } from '../hooks/useShortcuts';
import { useCatalog } from '../query/catalog';

/**
 * Casca do app: barra de abas, conteúdo da aba, rodapé e os overlays.
 * Também é quem entrega as faixas ao controller.
 */
export function AppLayout() {
  const { data } = useCatalog();
  const user = useSession((st) => st.user);
  const restored = useSession((st) => st.restored);
  const guest = useGuestMode((st) => st.guest);
  const gate = useUi((st) => st.gate);
  const { isPlayerOpen } = usePlayerOverlay();
  const { pathname } = useLocation();

  // Link de faixa não passa pela tela de login: quem recebeu o link quer
  // ouvir a música, não escolher um modo de sessão. O visitante já estava a
  // um clique de distância ali, e `/t/<lixo>` não parseia — esse continua
  // indo para o login como qualquer outra rota desconhecida.
  const deeplink = parseTrackPath(pathname);
  const entrarComoVisitante = useGuestMode((st) => st.enterAsGuest);
  useEffect(() => {
    if (deeplink && !user && !guest) entrarComoVisitante();
  }, [deeplink, user, guest, entrarComoVisitante]);

  useShortcuts(searchInputRef);

  const tracks = data?.tracks;
  useEffect(() => {
    controller.setTracks(tracks ?? []);
  }, [tracks]);

  const current = useCurrentTrack();

  // Espera a sessão persistida antes de decidir para onde mandar o usuário.
  if (!restored) return null;
  // No fluxo normal este ramo nem chega a ser alcançado num deeplink: o
  // efeito acima roda durante o quadro em que a sessão ainda não foi
  // restaurada, então `guest` já é true quando `restored` vira. Ele existe
  // para o caso em que a sessão cai COM a pessoa parada num `/t/...` — sair
  // da conta ali não pode jogá-la na tela de login e perder a faixa.
  if (!user && !guest) return deeplink ? null : <Navigate to="/login" replace />;

  return (
    <div className={s.app}>
      <TabBar />
      <main className={s.main}>
        <div className={s.content}>
          <Outlet />
        </div>
      </main>
      <BottomBar track={current} />
      {isPlayerOpen && current && <FullPlayer track={current} />}
      {gate && <Gate gate={gate} />}
    </div>
  );
}
