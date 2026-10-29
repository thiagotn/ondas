import { parseTrackPath } from '@ondas/core';
import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import * as controller from '../app/controller';
import { useGuestMode } from '../app/guest';
import { useSession, useUi } from '../app/stores';
import { AccountOverlay } from '../components/AccountOverlay';
import { BottomBar } from '../components/BottomBar';
import { FullPlayer } from '../components/FullPlayer';
import { Gate } from '../components/Gate';
import { HelpOverlay } from '../components/HelpOverlay';
import { TabBar } from '../components/TabBar';
import s from '../components/shell.module.css';
import { searchInputRef } from '../hooks/searchInputRef';
import { useCurrentTrack } from '../hooks/useCurrentTrack';
import { useAccountOverlay } from '../hooks/useAccountOverlay';
import { useHelpOverlay } from '../hooks/useHelpOverlay';
import { useShortcuts } from '../hooks/useShortcuts';
import { useCatalog } from '../query/catalog';
import { PATHS } from './paths';

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
  const { isHelpOpen } = useHelpOverlay();
  const { isAccountOpen } = useAccountOverlay();
  const { pathname } = useLocation();

  // `/t/...` diz duas coisas ao mesmo tempo, e por isso é um valor só: o
  // player cheio está aberto (ele é a rota da faixa, ver `usePlayerOverlay`) e
  // a pessoa pode ter chegado por um link de fora.
  //
  // Link de faixa não passa pela tela de login: quem recebeu o link quer
  // ouvir a música, não escolher um modo de sessão. O visitante já estava a
  // um clique de distância ali, e `/t/<lixo>` não parseia — esse continua
  // indo para o login como qualquer outra rota desconhecida.
  const faixaDaRota = parseTrackPath(pathname);
  const entrarComoVisitante = useGuestMode((st) => st.enterAsGuest);
  useEffect(() => {
    if (faixaDaRota && !user && !guest) entrarComoVisitante();
  }, [faixaDaRota, user, guest, entrarComoVisitante]);

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
  if (!user && !guest) return faixaDaRota ? null : <Navigate to={PATHS.login} replace />;

  return (
    <div className={s.app}>
      <TabBar />
      <main className={s.main}>
        <div className={s.content}>
          <Outlet />
        </div>
      </main>
      <BottomBar track={current} />
      {/* Rota E faixa: `current` vem do `curId`, que no primeiro quadro de
          `/t/<outra>` ainda é a faixa anterior. Sem o casamento, o player
          cheio da faixa velha apareceria sobre o endereço da nova — e cobriria
          o "resolvendo…" e o aviso de faixa privada do `TrackRoute`. */}
      {current?.id === faixaDaRota && <FullPlayer track={current} />}
      {/* Depois do player: aberto por cima dele quando os dois estão na URL. */}
      {isAccountOpen && <AccountOverlay />}
      {/* Por cima de tudo: é referência passageira, quem abre quer fechar em
          seguida — e é a primeira camada que o Esc tira. */}
      {isHelpOpen && <HelpOverlay />}
      {gate && <Gate gate={gate} />}
    </div>
  );
}
