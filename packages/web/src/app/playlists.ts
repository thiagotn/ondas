import { t, tErro, type Params } from '@ondas/core';
import { PlaylistsError, type Playlist } from '@ondas/core';
import { playlistsClient } from './services';
import { libraryStore, sessionStore, uiStore } from './stores';

/**
 * As playlists da conta, do lado do cliente.
 *
 * Irmão de `app/likes.ts`, com uma diferença que é decisão e não falta: NÃO HÁ
 * FILA. A curtida tem uma porque é reflexo que se faz sem rede, no avião, e
 * perdê-la seria perder um gesto. Criar e reordenar playlist é trabalho
 * deliberado: sem rede, a resposta honesta é recusar e dizer, e não guardar uma
 * reordenação para aplicar depois sobre um estado que mudou.
 *
 * Por isso a escrita aqui é SÍNCRONA no sentido que importa: a tela só muda
 * depois de o servidor confirmar, como em `togglePublico` e ao contrário de
 * `toggleLike`. A exceção é o `J`/`K`, explicada em `mover`.
 */

/** `JJJ` seguidos são um PATCH, não três. Mesmo valor do debounce da curtida. */
const DEBOUNCE_MS = 400;

let agendado: ReturnType<typeof setTimeout> | null = null;
/** A ordem que ainda não subiu: `[id da playlist, ids na ordem]`. */
let pendente: { id: string; ordem: readonly string[] } | null = null;

function playlists(): Playlist[] {
  return libraryStore.getState().playlists;
}

export function playlistPorID(id: string): Playlist | undefined {
  return playlists().find((p) => p.id === id);
}

/**
 * Põe o aparelho de acordo com o servidor. Chamada no boot e depois do login,
 * como `sincronizar` das curtidas — e sem laço nenhum.
 */
export async function carregarPlaylists(): Promise<void> {
  if (!sessionStore.getState().user) return;
  try {
    libraryStore.getState().setPlaylists(await playlistsClient.list());
  } catch (err) {
    // Só o 401 invalida o espelho; falta de rede não é o servidor dizendo não.
    if (err instanceof PlaylistsError && err.semSessao) esquecerPlaylists();
    else console.warn('[ondas] playlists indisponíveis:', err);
  }
}

/**
 * Esquece o que é da conta que saiu.
 *
 * Sem isto, as playlists de quem saiu continuariam no store e apareceriam para
 * a próxima conta que entrasse neste navegador. Apagar é seguro porque elas
 * estão no servidor: entrar de novo as traz. E aqui não há a ressalva da
 * curtida (o aparelho que nunca sincronizou), porque playlist nunca existiu
 * localmente antes de existir no servidor.
 */
export function esquecerPlaylists(): void {
  if (agendado) {
    clearTimeout(agendado);
    agendado = null;
  }
  pendente = null;
  libraryStore.getState().setPlaylists([]);
}

/**
 * Embrulho de toda escrita: aplica a resposta no espelho e põe o erro na tela.
 *
 * A mensagem do servidor é em pt-BR e dita para ser lida — nome em uso, teto
 * estourado —, então ela vai para o toast quando existe. Devolve se deu certo,
 * para quem chamou poder fechar um painel só no sucesso.
 */
async function escrever(acao: () => Promise<Playlist[]>, aviso: string): Promise<boolean> {
  const ui = uiStore.getState();
  if (!sessionStore.getState().user) {
    ui.flash(t('toast.playlistsExigemConta'));
    return false;
  }
  try {
    libraryStore.getState().setPlaylists(await acao());
    return true;
  } catch (err) {
    if (err instanceof PlaylistsError) {
      if (err.semSessao) {
        esquecerPlaylists();
        ui.flash(t('toast.sessaoExpirada'));
        return false;
      }
      ui.flash(tErro(err.codigo, err.params as Params | undefined) ?? err.message);
      return false;
    }
    // Rede fora é o caso comum do `catch` que sobra, e a frase diz isso em vez
    // de "erro desconhecido".
    console.warn('[ondas] playlist:', err);
    ui.flash(aviso);
    return false;
  }
}

export function criar(nome: string): Promise<boolean> {
  return escrever(() => playlistsClient.criar(nome), t('semRede.playlistNaoCriada'));
}

export function renomear(id: string, nome: string): Promise<boolean> {
  return escrever(() => playlistsClient.renomear(id, nome), t('semRede.nomeNaoMudou'));
}

export function apagar(id: string): Promise<boolean> {
  return escrever(() => playlistsClient.apagar(id), t('semRede.playlistNaoApagada'));
}

export function adicionar(id: string, ids: readonly string[]): Promise<boolean> {
  return escrever(() => playlistsClient.aplicar(id, { add: ids }), t('semRede.faixasNaoEntraram'));
}

export function remover(id: string, ids: readonly string[]): Promise<boolean> {
  return escrever(() => playlistsClient.aplicar(id, { remove: ids }), t('semRede.faixasNaoSairam'));
}

/**
 * Reordena: aplica no espelho AGORA e manda a ordem depois, com debounce.
 *
 * É a única escrita otimista daqui, e o motivo é a tecla: `J` repetido tem de
 * mover a linha no mesmo quadro, senão a pessoa aperta cinco vezes esperando a
 * rede e a faixa anda cinco casas depois, de uma vez. O otimismo é barato
 * porque a correção é de graça — a resposta do servidor é sempre a coleção
 * inteira, então uma falha restaura o estado de verdade sem código de desfazer.
 */
export function mover(id: string, ordem: readonly string[]): void {
  const atual = playlists();
  libraryStore
    .getState()
    .setPlaylists(atual.map((p) => (p.id === id ? { ...p, itens: [...ordem] } : p)));
  pendente = { id, ordem };
  if (agendado) clearTimeout(agendado);
  agendado = setTimeout(() => {
    agendado = null;
    void subirOrdem();
  }, DEBOUNCE_MS);
}

async function subirOrdem(): Promise<void> {
  const subindo = pendente;
  if (!subindo) return;
  pendente = null;
  const ok = await escrever(
    () => playlistsClient.aplicar(subindo.id, { ordem: subindo.ordem }),
    t('semRede.ordemNaoSalva'),
  );
  // Falhou: o espelho está com a ordem otimista, que não é a do servidor.
  // Reler é o desfazer, e ele não precisa saber o que foi tentado.
  if (!ok) await carregarPlaylists();
}

/**
 * Sobe uma ordem pendente ANTES de um momento em que ela morreria.
 *
 * É o mesmo cuidado do `logout` com a fila de curtidas: reordenar e sair em
 * seguida é um gesto só, e o debounce pode nem ter disparado — depois do
 * `auth.logout()` o PATCH só levaria 401.
 */
export async function subirPendente(): Promise<void> {
  if (!agendado) return;
  clearTimeout(agendado);
  agendado = null;
  await subirOrdem();
}
