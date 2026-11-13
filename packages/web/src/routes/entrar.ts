import { t, type User } from '@ondas/core';
import * as historico from '../app/historico';
import { adotarIdiomaDaConta } from '../app/idioma';
import { sincronizar } from '../app/likes';
import { carregarPlaylists } from '../app/playlists';
import * as prefs from '../app/prefs';
import { sessionStore, uiStore } from '../app/stores';
import { PATHS } from './paths';

/**
 * O que acontece depois que o servidor devolve uma sessão: a conta assume o
 * aparelho e a tela vai para a home.
 *
 * Função própria porque são duas as portas por onde uma sessão chega — o login,
 * e o pedido de conta de quem o admin já tinha liberado (allowlist), que sai
 * logado na hora. A ordem dos passos importa e não pode existir em duas cópias.
 */
export async function assumirSessao(user: User, navigate: (to: string) => void): Promise<void> {
  sessionStore.getState().setUser(user);
  // A aparência da conta, antes de sair desta tela: tema e fundo já valem
  // aqui, e o idioma decide PARA ONDE se sai. O `await` é só de disco — o
  // que tiver de subir sobe por conta própria.
  const idiomaDaConta = await prefs.iniciar(user);
  // Traz as curtidas da conta — e sobe as que este aparelho guardava de
  // antes de elas serem da conta (`app/likes.ts`).
  void sincronizar();
  // E as playlists, pela mesma razão: elas são da conta, e o espelho deste
  // navegador acabou de ficar velho.
  void carregarPlaylists();
  // E o ponto onde a conta parou, que vira a faixa pausada no player.
  void historico.iniciar({ novaSessao: true });
  uiStore.getState().closeGate();
  // A conta fala outro idioma, e este aparelho ainda não sabia: a home é
  // aberta já sob o prefixo dele, com uma navegação de verdade. O aviso de
  // boas-vindas não é mostrado nesse caso — ele morreria com a página.
  if (idiomaDaConta && adotarIdiomaDaConta(idiomaDaConta, PATHS.home)) return;
  uiStore.getState().flash(t('login.autenticado', { nome: user.name }));
  navigate(PATHS.home);
}
