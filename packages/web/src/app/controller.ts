import {
  faixaPorNumero,
  firstPlayable,
  fmtMB,
  indexOfTrack,
  librarySegmentChip,
  moverNaOrdem,
  offlineBytes,
  onEnded,
  playability,
  prefetchTarget,
  showsPublicCatalog,
  stepIndex,
  t,
  valeRetomar,
  type Chave,
  type Pendencia,
  type QueueContext,
  type ThemeId,
  type Track,
  type User,
} from '@ondas/core';
import {
  bindMediaSessionActions,
  setMediaMetadata,
  setMediaPlaybackState,
  setMediaPosition,
} from '../platform/mediaSession';
import { compartilhar } from '../platform/share';
import { aoSairDaTela, aoVoltarParaATela } from '../platform/visibilidade';
import { applyTheme, storeTheme } from '../theme/applyTheme';
import { queryClient } from '../query/client';
import { CATALOG_LOGADO_KEY, catalogKey } from '../query/catalog';
import { ehCotaExcedida } from '../platform/CacheOfflineStore';
import { useAvulsas } from './extras';
import * as historico from './historico';
import { esquecerCurtidas, registrar, sincronizar } from './likes';
import * as listas from './playlists';
import { auth, connectivity, engine, offlineStore } from './services';
import { libraryStore, playerStore, sessionStore, uiStore } from './stores';

/** O rótulo da janela de conta, citado dentro de frase. Ver `view.ts`. */
const JANELA_CONTA = 'ondas whoami';

/**
 * Orquestra stores, motor de áudio e armazenamento offline — o papel que a
 * `class Component` tinha no protótipo. Os componentes só chamam estes
 * comandos; nenhum deles fala com o `HTMLAudioElement` ou com a Cache API.
 */

/** Faixas e estado de rede vêm do React (query + eventos) para cá. */
let tracks: readonly Track[] = [];
let online = true;

export function setTracks(next: readonly Track[]): void {
  tracks = next;
  // A lista muda de tamanho ao entrar (o acervo entra na frente) e ao sair.
  // Como `cur` é posição nela, sem reancorar pelo `curId` o player mostraria
  // uma faixa e tocaria outra.
  const player = playerStore.getState();
  if (!player.curId) return;
  const reancorado = indexOfTrack(next, player.curId);
  if (reancorado !== player.cur) player.patch({ cur: reancorado });
}

export function setOnline(next: boolean): void {
  online = next;
}

/**
 * Offline de verdade, ou a simulação de rede do build de dev.
 *
 * Isto NÃO decide mais se uma faixa pode tocar (ver `access.ts`): decide o
 * indicador da barra, se vale disparar um download e qual recado dar quando o
 * playback falha de fato.
 */
export function isOffline(): boolean {
  return !online || (import.meta.env.DEV && uiStore.getState().simulatedOffline);
}

/**
 * Quantas faixas seguidas podem falhar antes de o player desistir.
 *
 * Sem este teto, uma queda de rede vira um desfile: `engine.on('error')` chama
 * `avancar(1)`, que chama `tocarFaixa`, que erra de novo — o app atravessaria
 * o catálogo inteiro sozinho piscando toast. Três deixa passar uma ou duas
 * faixas realmente quebradas e segura a queda geral.
 */
const LIMITE_DE_FALHAS = 3;
let falhasSeguidas = 0;

/**
 * O que o player queria estar fazendo quando parou, para retomar quando der —
 * a rede voltando, ou a tela acendendo. `null` = ninguém espera nada.
 *
 * Quando ela ainda vale é regra do `core` (`valeRetomar`), não daqui.
 */
let pendencia: Pendencia | null = null;

/**
 * Para de tocar e CONTA para a tela de bloqueio.
 *
 * Os três caminhos que calam o player mexiam só na store, e a notificação do
 * Android seguia dizendo "tocando" sobre o silêncio — com um botão de pause
 * para um som que não existe mais.
 */
function pararNaTela(): void {
  playerStore.getState().patch({ playing: false, waiting: false });
  setMediaPlaybackState(false);
}

/**
 * Qualquer comando vindo da pessoa: barra, teclado, fone, tela de bloqueio.
 *
 * O que o automático armou não sobrevive a um gesto. Sem isto, `falhasSeguidas`
 * só zerava quando saía som — duas falhas antigas, distantes na sessão, mais
 * uma nova fechavam o teto — e uma pendência esquecida podia ressuscitar uma
 * faixa velha no primeiro evento de rede.
 */
function gestoDaPessoa(): void {
  falhasSeguidas = 0;
  pendencia = null;
}

/**
 * A faixa que a restauração do marcador pôs no player, e que ainda não tocou.
 *
 * ARMADA quer dizer: está na store e na tela — título, capa, a barra parada no
 * segundo onde a conta parou — e o motor de áudio não sabe dela. Nenhum
 * `engine.load` foi feito, de propósito: carregar no boot é pedir bytes que
 * talvez ninguém ouça e, pior, é dar ao `engine.on('error')` a chance de pular
 * para a faixa seguinte e TOCÁ-LA, sem gesto nenhum, por causa de um stream
 * que morreu desde ontem.
 *
 * O áudio só é pedido no primeiro play (`togglePlay`), que carrega a faixa já
 * na posição guardada aqui. Qualquer outro caminho que toque alguma coisa
 * passa por `tocarFaixa`, que desarma.
 */
let armado: { id: string; pos: number } | null = null;

/**
 * Põe a faixa do marcador no player, pausada na posição. Devolve `false` se
 * ela não coube: não está na lista, não é tocável, ou há som saindo.
 *
 * Quem decide SE restaurar é `app/historico.ts`; aqui só se recusa o que seria
 * errado em qualquer circunstância.
 */
export function armar(id: string, pos: number): boolean {
  const index = indexOfTrack(tracks, id);
  const track = tracks[index];
  if (!track) return false;
  const player = playerStore.getState();
  // Nunca por cima de música: nem da que está saindo, nem da que foi pedida e
  // ainda carrega.
  if (player.playing || player.waiting) return false;
  // Sem abrir gate: a pessoa não pediu nada, e um bloqueio aqui é só motivo
  // para não restaurar.
  if (!playability(track, index, { session: sessionStore.getState().user }).ok) return false;
  // Se havia uma faixa carregada e pausada no motor, ela fica lá, muda: o play
  // seguinte carrega a armada por cima.
  engine.pause();
  armado = { id, pos };
  playerStore
    .getState()
    .loadPaused(index, id, track.dur, libraryStore.getState().cached[id] ? 1 : 0, pos);
  setMediaMetadata(track);
  setMediaPlaybackState(false);
  return true;
}

/** O id da faixa armada e intocada, ou `null`. */
export function armadoEm(): string | null {
  return armado && armado.id === playerStore.getState().curId ? armado.id : null;
}

/**
 * Vai para um ponto da faixa. Com o player armado não há áudio para
 * posicionar: muda só o ponto de onde o play vai partir.
 */
function irPara(seconds: number): void {
  if (armado && armado.id === playerStore.getState().curId) {
    armado.pos = seconds;
    playerStore.getState().patch({ t: seconds });
    return;
  }
  engine.seek(seconds);
}

/**
 * Para de tocar DIZENDO que parou.
 *
 * O silêncio era o bug: `onEnded` devolvia `stop` e o player só punha
 * `playing: false`. Quem estava com o telefone no bolso não tinha como saber
 * que a música tinha acabado ali — e nada retomava quando a rede voltava.
 */
function desistir(chave: Chave): void {
  falhasSeguidas = 0;
  pendencia = { tipo: 'avancar', index: playerStore.getState().cur, em: Date.now() };
  pararNaTela();
  uiStore.getState().flash(t(chave));
}

/**
 * Alguma coisa avisou que é hora de tentar de novo: a rede voltou, ou a tela
 * acendeu.
 *
 * UMA tentativa por aviso: a pendência é limpa antes de tentar. Se a retomada
 * também não começar (autoplay barrado, por exemplo), `tocarFaixa` rearma a
 * pendência — mas sem gesto nenhum da pessoa isso não vira laço, porque cada
 * rearme precisa de um novo aviso.
 */
async function retomar(chave: Chave): Promise<void> {
  const alvo = pendencia;
  pendencia = null;
  // Quem diz se isto ainda é o que a pessoa queria é o `core`: pendência
  // velha caducou, e player que já voltou a tocar não pode ser reiniciado do
  // `0:00` só porque alguém acendeu a tela.
  //
  // "Tocando" aqui é `playing` da store, e NÃO `!engine.isPaused()`: um
  // elemento a quem se pediu `play()` e cuja fonte morreu continua com
  // `paused === false` — ele está "querendo tocar" sem som nenhum sair. Só o
  // evento `playing` do elemento conta, e é dele que a store vem.
  if (!valeRetomar(alvo, Date.now(), playerStore.getState().playing)) return;
  // O destino primeiro, o anúncio depois: sem isto a tela dizia "retomando" e
  // não retomava nada quando não havia faixa para onde ir.
  const destino =
    alvo.tipo === 'retomar' && alvo.index >= 0 ? alvo.index : stepIndex(queueContext(), 1);
  if (destino < 0) return;
  uiStore.getState().flash(t(chave));
  await tocarFaixa(destino);
}

function queueContext(): QueueContext {
  const lib = libraryStore.getState();
  const player = playerStore.getState();
  return {
    tracks,
    session: sessionStore.getState().user,
    cached: lib.cached,
    shuffle: player.shuffle,
    repeat: player.repeat,
    cur: player.cur,
    // A FILA é a lista da tela, e o fio para cá já existia: o `TrackList`
    // empurra os ids visíveis desde que `j`/`k` passaram a andar pelo recorte
    // (ver `setVisible`). Ligá-lo aqui é o que faz `n` seguir a playlist — e,
    // de passagem, o que faz `n` em `--curtidas` parar de sair do recorte.
    fila: visiveis,
  };
}

export function currentTrack(): Track | undefined {
  const { cur } = playerStore.getState();
  return cur >= 0 ? tracks[cur] : undefined;
}

/**
 * As esperas antes de cada nova tentativa de começar, em ms. Uma espera por
 * recomeço — a primeira tentativa não espera, então são quatro no total.
 *
 * Curtas de propósito. A página em segundo plano **sem áudio tocando** perde a
 * isenção de throttling do navegador — e é exatamente a situação aqui, porque
 * o som parou. Um `setTimeout` de 30s ali pode simplesmente não acontecer; o
 * que passar deste teto é coberto por `aoVoltarParaATela`.
 */
const ESPERAS_ATE_DESISTIR = [400, 1500, 4000] as const;

const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** O que houve com a tentativa de fazer o som sair. */
type Comeco = 'tocou' | 'abandonada' | 'desistiu';

/**
 * Insiste até o som sair, a faixa mudar, ou acabar a paciência.
 *
 * Uma tentativa só era o que transformava um tropeço de meio segundo em
 * silêncio até alguém pegar o telefone: a recusa do navegador em segundo plano
 * é TRANSITÓRIA — no incidente de 2026-11-05 a pessoa apertou play e a mesma
 * faixa tocou na hora.
 *
 * Isto mora no controller, e não no engine, porque a guarda é `curId`: saber
 * qual faixa é a de agora é conhecimento de domínio, e o motor de áudio
 * continua burro.
 */
async function comecar(track: Track): Promise<Comeco> {
  for (let i = 0; ; i++) {
    await engine.play();
    // A promise do `play()` resolve quando o som começa, então ainda estar
    // pausado aqui significa que não começou.
    if (!engine.isPaused()) return 'tocou';
    // A faixa mudou embaixo de nós: `n` apertado duas vezes, ou o handler de
    // `error` já pulou. Esta tentativa não é mais nossa — sem esta guarda a
    // tela diria "não começou" por cima da faixa que já está tocando.
    if (playerStore.getState().curId !== track.id) return 'abandonada';
    const espera = ESPERAS_ATE_DESISTIR[i];
    if (espera === undefined) return 'desistiu';
    // Entre uma tentativa e outra o estado é BUF, não PAUSE: o `catch` do
    // engine acabou de emitir `playing:false`, e piscar PAUSE enquanto ainda
    // se tenta seria mentira ao contrário. A tela de bloqueio não é tocada.
    playerStore.getState().patch({ playing: true, waiting: true });
    await esperar(espera);
    // E de novo, colada no `engine.play()` do próximo giro: sem isto, o
    // perdedor de uma corrida acordaria da espera e daria play na faixa do
    // vencedor.
    if (playerStore.getState().curId !== track.id) return 'abandonada';
  }
}

/**
 * Toca a faixa do índice. É o caminho AUTOMÁTICO — fim de faixa, retomada,
 * avanço por erro. Gesto da pessoa entra por `play`, que limpa o que o
 * automático armou antes de chegar aqui.
 */
async function tocarFaixa(index: number, inicio = 0): Promise<void> {
  const track = tracks[index];
  if (!track) return;
  // Tudo o que toca passa por aqui, e tocar qualquer coisa desarma: a faixa do
  // marcador deixa de ser "a que está esperando o play".
  armado = null;
  const lib = libraryStore.getState();
  const ui = uiStore.getState();
  const verdict = playability(track, index, { session: sessionStore.getState().user });
  if (!verdict.ok) {
    ui.openGate('play', track.title);
    return;
  }

  // Object URL da faixa anterior não serve mais.
  const previousId = playerStore.getState().curId;
  if (previousId && previousId !== track.id) offlineStore.releaseUrl(previousId);

  const cached = !!lib.cached[track.id];
  playerStore.getState().load(index, track.id, track.dur, cached ? 1 : 0);

  let src = track.stream;
  if (cached && track.stream) {
    const local = await offlineStore.get(track.id);
    // A cópia local sumiu (faxina do navegador, cota): vale a URL remota. Havia
    // aqui um `else if (isOffline()) src = ''`, e `src` vazio não é "sem
    // fonte" — é o playback SIMULADO, que fingia tocar uma faixa real em
    // silêncio. Tentar a rede e falhar com recado é melhor que isso.
    if (local) src = local;
  } else if (!track.stream) {
    // Faixa demo: sem áudio, playback simulado.
    src = '';
  }

  engine.load(track, src);
  setMediaMetadata(track);
  // A retomada do marcador: a faixa começa de onde a conta parou. O `patch` é
  // para a tela — `load` acabou de zerar o tempo, e a barra piscaria `0:00`
  // até o áudio carregar. O `seek` o motor guarda e aplica quando souber a
  // duração (ver `seekPendente` no `WebPlayerEngine`).
  if (inicio > 0) {
    playerStore.getState().patch({ t: inicio });
    engine.seek(inicio);
  }

  // `WebPlayerEngine.play()` engole a recusa do navegador (autoplay barrado é
  // uma promise rejeitada, não um evento de erro), e a tela só voltava para
  // PAUSE sem dizer por quê.
  if ((await comecar(track)) === 'desistiu') {
    pararNaTela();
    ui.flash(t('toast.naoComecou'));
    pendencia = { tipo: 'retomar', index, em: Date.now() };
  }

  // Incondicional de propósito: se a faixa NÃO começou, pôr os bytes dela no
  // aparelho é a melhor jogada que existe para a retomada seguinte.
  if (lib.prefetch && sessionStore.getState().user) void prefetchNext(index);
}

/**
 * Toca a faixa do índice por ordem da pessoa — toque na linha, Enter no
 * cursor, link direto.
 */
export async function play(index: number): Promise<void> {
  gestoDaPessoa();
  await tocarFaixa(index);
}

export function togglePlay(): void {
  const player = playerStore.getState();
  gestoDaPessoa();
  if (player.cur < 0) {
    const first = firstPlayable(queueContext());
    if (first >= 0) void tocarFaixa(first);
    return;
  }
  // O primeiro play depois da restauração: é AQUI que o áudio é pedido, já na
  // posição do marcador. Vale para a barra, o espaço e a tela de bloqueio —
  // os três chegam por esta função.
  if (armado && armado.id === player.curId) {
    void tocarFaixa(player.cur, armado.pos);
    return;
  }
  // `engine.play()`, e não `tocarFaixa(cur)`: um pause/play no meio da faixa
  // não pode recarregar a `src` e perder a posição.
  if (engine.isPaused()) void engine.play();
  else engine.pause();
}

/**
 * Anda na fila sem gesto nenhum — é por aqui que o handler de `error` pula a
 * faixa quebrada. Não zera `falhasSeguidas`: zerar aqui destruiria o teto,
 * porque é justamente a sequência de avanços automáticos que ele conta.
 */
function avancar(dir: 1 | -1): void {
  const next = stepIndex(queueContext(), dir);
  if (next >= 0) void tocarFaixa(next);
}

/** `n`/`p`, os botões do player e os do fone: gesto da pessoa. */
export function step(dir: 1 | -1): void {
  gestoDaPessoa();
  avancar(dir);
}

/** Ids das linhas que estão na tela, em ordem. */
let visiveis: readonly string[] = [];

/**
 * O recorte visível, empurrado pelo `TrackList`.
 *
 * `tracks` é a lista completa; `j`/`k` precisam andar pelo que a pessoa vê, e
 * em `--curtidas` ou na busca isso é um filtro esparso dela. Sem este fio o
 * cursor pularia para faixas fora da tela.
 */
export function setVisible(ids: readonly string[]): void {
  visiveis = ids;
}

/**
 * Marca a faixa pelo número da calha (`:08`). Devolve-a, ou `undefined` com um
 * toast quando aquele número não existe.
 */
export function irParaFaixa(numero: number): Track | undefined {
  const track = faixaPorNumero(tracks, numero);
  const ui = uiStore.getState();
  if (!track) {
    ui.flash(t('toast.faixaNaoExiste', { numero }));
    return undefined;
  }
  ui.setCursor(track.id);
  return track;
}

/**
 * Marca uma linha pelo id, sem tocá-la. É por aqui que o Tab entra: a linha
 * que recebe o foco vira a linha do cursor, para a lista ter uma marca só.
 */
export function marcarCursor(id: string): void {
  uiStore.getState().setCursor(id);
}

/**
 * Anda o cursor na lista visível, sem dar a volta: `k` no topo fica no topo,
 * como no vim.
 *
 * Sem cursor — ou com um cursor que saiu do recorte, ao trocar o gênero —
 * começa na faixa que está tocando, se ela estiver na tela, e senão na
 * primeira linha.
 */
export function moverCursor(dir: 1 | -1): void {
  if (!visiveis.length) return;
  const ui = uiStore.getState();
  const atual = ui.cursorId ? visiveis.indexOf(ui.cursorId) : -1;
  if (atual < 0) {
    const tocando = visiveis.indexOf(playerStore.getState().curId ?? '');
    ui.setCursor(visiveis[Math.max(0, tocando)] ?? null);
    return;
  }
  ui.setCursor(visiveis[Math.min(visiveis.length - 1, Math.max(0, atual + dir))] ?? null);
}

/** Toca a linha marcada. Resolve por id — índice guardado envelhece. */
export function tocarCursor(): void {
  const index = indexOfTrack(tracks, uiStore.getState().cursorId);
  if (index >= 0) void play(index);
}

/** Seek por fração da duração (clique na waveform). */
export function seekFraction(fraction: number): void {
  const { dur } = playerStore.getState();
  if (!dur) return;
  irPara(Math.min(1, Math.max(0, fraction)) * dur);
}

export function seekBy(seconds: number): void {
  const { t, dur } = playerStore.getState();
  if (!dur) return;
  irPara(Math.min(dur, Math.max(0, t + seconds)));
}

/**
 * Curte ou descurte, otimista.
 *
 * A curtida é da CONTA desde a migração 0006, então sem sessão não há onde
 * guardá-la — e dizer isso é melhor que um coração que acende e some no
 * próximo boot. O mesmo caminho atende o clique na lista, o botão do player e
 * a tecla `l`.
 *
 * A tela muda ANTES da rede, ao contrário de `togglePublico`: lá um erro
 * deixaria a lista inteira mudando sozinha, aqui o pior caso é um coração que
 * a fila sobe depois. É a fila que torna isso honesto.
 */
export function toggleLike(id: string): void {
  if (!sessionStore.getState().user) {
    uiStore.getState().flash(t('toast.curtirExigeConta'));
    return;
  }
  const curtir = !libraryStore.getState().liked[id];
  libraryStore.getState().toggleLike(id);
  void registrar(id, curtir);
}

export function likeCurrent(): void {
  const track = currentTrack();
  if (track) toggleLike(track.id);
}

/**
 * Liga o modo de seleção, ou marca uma linha se ele já está ligado.
 *
 * Uma função para as duas portas — a tecla `v` e o toque longo na linha
 * (`useToqueLongo`) —, e é ela que recusa sem sessão: playlist é da conta, e um
 * modo de seleção que não leva a nada seria pior que a recusa.
 */
export function marcar(id?: string): void {
  if (!sessionStore.getState().user) {
    uiStore.getState().flash(t('toast.playlistsExigemConta'));
    return;
  }
  const ui = uiStore.getState();
  if (!ui.selecionando) {
    ui.entrarNaSelecao(id);
    return;
  }
  if (id) ui.alternarMarca(id);
}

/** Marca ou desmarca a linha do cursor (tecla `x`). */
export function marcarCursorNaSelecao(): void {
  const id = uiStore.getState().cursorId;
  if (id) marcar(id);
}

/**
 * As marcadas, NA ORDEM EM QUE FORAM MARCADAS.
 *
 * É a ordem das chaves do objeto, que para chave de texto é a de inserção.
 * Marcando de cima para baixo — o caso normal — ela é a ordem da lista; e
 * desmarcar e marcar de novo manda a faixa para o fim, que é o que a pessoa
 * acabou de pedir.
 */
function marcadasEmOrdem(): string[] {
  return Object.keys(uiStore.getState().marcadas);
}

export function quantasMarcadas(): number {
  return marcadasEmOrdem().length;
}

/** Põe as marcadas numa playlist que já existe. */
export async function adicionarMarcadas(playlistID: string): Promise<void> {
  const ids = marcadasEmOrdem();
  if (!ids.length) return;
  const nome = listas.playlistPorID(playlistID)?.nome ?? 'playlist';
  if (!(await listas.adicionar(playlistID, ids))) return;
  uiStore.getState().sairDaSelecao();
  uiStore.getState().flash(t('toast.faixasParaPlaylist', { n: ids.length, nome }));
}

/**
 * Cria a playlist e põe as marcadas nela.
 *
 * Dois pedidos, e não um: o `POST` não aceita itens de propósito (criar e
 * encher são coisas diferentes do lado do servidor). O id da nova sai da
 * resposta pelo NOME, que é único por conta — é a única coisa que quem pediu
 * conhece, e o índice único garante que não há duas.
 */
export async function criarComMarcadas(nome: string): Promise<void> {
  if (!(await listas.criar(nome))) return;
  const nova = libraryStore.getState().playlists.find((p) => p.nome === nome);
  if (!nova) {
    uiStore
      .getState()
      .flash(t('toast.playlistCriadaAbra', { recorte: librarySegmentChip('playlists') }));
    return;
  }
  if (!marcadasEmOrdem().length) {
    uiStore.getState().sairDaSelecao();
    uiStore.getState().flash(t('toast.playlistCriada', { nome }));
    return;
  }
  await adicionarMarcadas(nova.id);
}

/** Tira as marcadas da playlist que está aberta. */
export async function removerMarcadas(playlistID: string): Promise<void> {
  const ids = marcadasEmOrdem();
  if (!ids.length) return;
  if (!(await listas.remover(playlistID, ids))) return;
  uiStore.getState().sairDaSelecao();
  uiStore.getState().flash(t('toast.faixasTiradas', { n: ids.length }));
}

/**
 * Move uma faixa na playlist aberta (`J`/`K`, ou os botões da barra).
 *
 * A faixa é a do cursor, e não a que está tocando: mexer na ordem é editar a
 * lista que se está olhando. Com exatamente uma marcada, é ela — é o caminho do
 * celular, onde não há cursor.
 */
export function moverNaPlaylist(playlistID: string, dir: 1 | -1): void {
  const lista = listas.playlistPorID(playlistID);
  if (!lista) return;
  const marcadas = marcadasEmOrdem();
  const alvo = marcadas.length === 1 ? marcadas[0]! : uiStore.getState().cursorId;
  if (!alvo) return;
  const nova = moverNaOrdem(lista.itens, alvo, dir);
  // Mesma referência = borda da lista, ou faixa que não é item: não gasta PATCH
  // para não fazer nada.
  if (nova === lista.itens) return;
  // O cursor acompanha a faixa, senão a tecla seguinte moveria a vizinha.
  uiStore.getState().setCursor(alvo);
  listas.mover(playlistID, nova);
}

export async function renomearPlaylist(id: string, nome: string): Promise<void> {
  if (await listas.renomear(id, nome))
    uiStore.getState().flash(t('toast.playlistRenomeada', { nome }));
}

export async function apagarPlaylist(id: string): Promise<void> {
  const nome = listas.playlistPorID(id)?.nome ?? '';
  if (await listas.apagar(id)) uiStore.getState().flash(t('toast.playlistApagada', { nome }));
}

/** Manda o link da faixa que está tocando (tecla `c` e botão do player). */
export function shareCurrent(): void {
  const track = currentTrack();
  if (track) void compartilhar(track);
}

/**
 * Baixa, ou remove se já estiver no aparelho (o mesmo botão faz as duas coisas).
 * `silent` é o smart buffer, que não deve roubar a atenção com toasts de erro.
 */
export async function download(track: Track, silent = false): Promise<void> {
  const ui = uiStore.getState();
  const lib = libraryStore.getState();
  if (!sessionStore.getState().user) {
    ui.openGate('dl', track.title);
    return;
  }
  if (lib.cached[track.id]) {
    await offlineStore.remove(track.id);
    libraryStore.getState().unmarkCached(track.id);
    ui.flash(t('toast.removidaDoAparelho'));
    return;
  }
  if (lib.dl[track.id] != null) return;
  // Só quem pediu com o dedo é barrado por `navigator.onLine` — e avisado.
  //
  // O BUFFER AUTOMÁTICO TENTA, e isto é a lição de 2026-11-04 aplicada ao
  // lugar que ficou de fora. Aquele conserto tirou a mentira do
  // `navigator.onLine` do caminho de TOCAR e a deixou aqui, no de BAIXAR —
  // justamente a rede de segurança que faz a troca de faixa não depender do
  // rádio. Com o Wi-Fi dormindo (tela bloqueada no Android) o buffer se
  // desligava sozinho, e cada troca passava a apostar que o rádio acordaria a
  // tempo. Em 2026-11-05 ele não acordou. Quem descobre que não há rede é o
  // `fetch`, falhando — e falha de buffer já é silenciosa (ver o `catch`).
  if (!silent && isOffline()) {
    ui.flash(t('toast.conecteParaBaixar'));
    return;
  }

  const done = (size: number) => {
    libraryStore.getState().setDl(track.id, null);
    libraryStore.getState().markCached(track.id, size);
    ui.flash(t(silent ? 'toast.bufferSalvo' : 'toast.salvaNoAparelho'));
  };

  // Faixa demo não tem bytes para baixar: progresso encenado, igual ao protótipo.
  if (!track.stream) {
    libraryStore.getState().setDl(track.id, 0);
    let p = 0;
    const timer = setInterval(() => {
      p += 0.12;
      if (p < 1) {
        libraryStore.getState().setDl(track.id, p);
        return;
      }
      clearInterval(timer);
      void offlineStore.putPlaceholder(track.id).then(() => done(track.dur * 16000));
    }, 160);
    return;
  }

  libraryStore.getState().setDl(track.id, 0);
  try {
    const size = await offlineStore.put(track.id, track.stream, (p) =>
      libraryStore.getState().setDl(track.id, p),
    );
    done(size);
  } catch (err) {
    libraryStore.getState().setDl(track.id, null);
    // Sem espaço e sem rede falhavam com a mesma frase, e a pessoa ficava
    // tentando de novo contra um telefone cheio. São saídas diferentes: uma
    // espera sinal, a outra espera uma faxina.
    if (ehCotaExcedida(err)) {
      console.warn('[ondas] sem espaço para baixar:', err);
      if (!silent) ui.flash(t('toast.semEspaco', { janelaConta: JANELA_CONTA }));
      return;
    }
    console.warn('[ondas] download falhou:', err);
    if (!silent) ui.flash(t('toast.falhaDownload'));
  }
}

export function downloadCurrent(): void {
  const track = currentTrack();
  if (track) void download(track);
}

/** Smart buffer: pré-carrega silenciosamente a próxima faixa desbloqueada. */
async function prefetchNext(index: number): Promise<void> {
  const target = prefetchTarget(queueContext(), index);
  const track = target >= 0 ? tracks[target] : undefined;
  if (track) await download(track, true);
}

export function setTheme(id: ThemeId): void {
  storeTheme(id);
  applyTheme(id, uiStore.getState().opacity);
  uiStore.getState().setThemeId(id);
  uiStore.getState().closePicker();
  uiStore.getState().flash(t('toast.tema', { tema: id }));
}

export async function logout(): Promise<void> {
  // A fila sobe ANTES de o cookie morrer. Curtir e sair em seguida é um gesto
  // só, e o debounce de `registrar` pode nem ter disparado ainda: depois do
  // `auth.logout()` o PATCH só levaria 401, e a curtida morreria no caminho.
  await sincronizar();
  // Pelo mesmo motivo, para a ordem que o `J`/`K` deixou pendente.
  await listas.subirPendente();
  // E para a posição dos últimos segundos, e a faixa que acabou de contar como
  // ouvida: o marcador sobe a cada quinze segundos de música, e sair no meio
  // do intervalo deixaria a conta um trecho atrás.
  await historico.subirPendente();
  await auth.logout();
  sessionStore.getState().setUser(null);
  // O catálogo do logado tem as faixas do acervo, e ele fica persistido em
  // IndexedDB. Sair sem apagar deixaria os metadados das faixas próprias no
  // aparelho à espera do próximo visitante.
  //
  // Pelo prefixo: são dois escopos do logado (com e sem catálogo público), e os
  // dois têm faixa do acervo dentro.
  queryClient.removeQueries({ queryKey: CATALOG_LOGADO_KEY });
  // Pelo mesmo motivo, e com um risco a mais: curtida que fica no store depois
  // de sair seria ADOTADA pela próxima conta que entrasse neste navegador.
  await esquecerCurtidas();
  // E as playlists, pelo mesmo risco: espelho que fica aparece para a próxima
  // conta que entrar neste navegador.
  listas.esquecerPlaylists();
  // E o marcador e o histórico, pelo mesmo risco e com um a mais: o espelho
  // `pendente` de quem saiu seria GRAVADO na conta de quem entrasse.
  await historico.esquecer();
  // A faixa armada é a última coisa que a conta ouviu, parada na barra de
  // baixo à vista de quem pegar o aparelho. Música que está tocando fica —
  // sair da conta nunca parou o som —, mas esta ninguém pediu para ouvir.
  if (armadoEm()) {
    armado = null;
    playerStore.getState().reset();
  }
  // Marca de seleção é da tela, e a tela é de quem entrou agora.
  uiStore.getState().sairDaSelecao();
}

/**
 * Liga ou desliga o catálogo público desta conta.
 *
 * A ordem dos passos é o que impede o pior bug possível aqui. Trocar a sessão
 * primeiro trocaria a chave da consulta, e por um commit o `data` seria
 * `undefined`: o efeito de `AppLayout` chamaria `setTracks([])`, a reancoragem
 * não acharia o `curId` e cravaria `cur: -1` — a barra de baixo DESAPARECE com
 * o áudio ainda tocando, `c`/`d`/`l` viram no-op e `n`/`p` saltam para o começo
 * da lista. É o mesmo bug que `extras.ts` descreve, e para uma faixa pública
 * que acabou de sair da lista ele nunca se curaria sozinho.
 *
 * Então: grava no servidor, salva a faixa que toca, SEMEIA a chave nova, e só
 * aí troca a sessão. Nenhum commit vê a lista vazia.
 */
export async function togglePublico(): Promise<void> {
  const ui = uiStore.getState();
  const user = sessionStore.getState().user;
  if (!user) return;
  const ligado = showsPublicCatalog(user);

  let novo: User;
  try {
    // Primeiro o servidor: um PATCH que falha não muda nada na tela.
    novo = await auth.setPublico(!ligado);
  } catch (err) {
    console.warn('[ondas] não foi possível salvar a preferência:', err);
    ui.flash(t('toast.falhaCatalogo'));
    return;
  }

  // A faixa pública que está tocando vira avulsa antes de sair da lista.
  // `comFaixasAvulsas` a anexa a qualquer catálogo que a chave nova resolva, e
  // é assim que a barra de baixo, `--curtidas` e `--offline` a mantêm. Avulsas
  // não persistem, e um reload já para o áudio — nada escapa da sessão.
  const tocando = currentTrack();
  if (tocando && !tocando.source) useAvulsas.getState().add(tocando);

  // Semeia a chave nova para que o primeiro commit depois da troca já tenha
  // dado — nos DOIS sentidos, porque o commit vazio não tem lado preferido.
  //
  // Só semeia quando não há nada ali: religando dentro das 24h de `gcTime`, o
  // escopo público ainda tem a lista misturada da sessão anterior, e substituí-la
  // por uma só do acervo seria jogar fora dado bom para pôr dado pior.
  //
  // A semente é o acervo, e a origem `acervo` é verdade no instante em que
  // ela aparece: é só isso que está na tela. O `invalidateQueries` abaixo busca a
  // versão autoritativa por baixo, e o prompt diz `· atualizando` enquanto isso.
  const chaveNova = catalogKey(true, !ligado);
  if (!queryClient.getQueryData(chaveNova)) {
    const proprias = tracks.filter((t) => t.source === 'acervo');
    queryClient.setQueryData(chaveNova, {
      tracks: [...proprias],
      source: 'acervo',
      acervo: proprias.length,
    });
  }

  sessionStore.getState().setUser(novo);
  void queryClient.invalidateQueries({ queryKey: CATALOG_LOGADO_KEY });
  ui.flash(t(ligado ? 'toast.catalogoDesligado' : 'toast.catalogoLigado'));
}

/**
 * Apaga TODAS as faixas baixadas e zera o índice.
 *
 * Existe porque `logout()` não leva a parte local embora: sair da conta apaga
 * o catálogo do acervo, mas os bytes do áudio continuam no aparelho sem tela
 * nenhuma que os mostre. Este é o botão que faltava.
 *
 * Reconcilia a partir do que sobrou em vez de limpar o índice na mão: se uma
 * remoção falhar, o índice continua contando aquela faixa — que ainda está lá.
 *
 * A faixa que estiver tocando não para: revogar um object URL invalida novos
 * carregamentos, não o que o `<audio>` já carregou. Um pulo grande depois
 * disso pode precisar da rede.
 */
export async function clearDownloads(): Promise<void> {
  const antes = offlineBytes(libraryStore.getState());
  for (const id of await offlineStore.keys()) {
    await offlineStore.remove(id);
  }
  libraryStore.getState().reconcile(await offlineStore.keys());
  uiStore.getState().flash(t('toast.downloadsApagados', { tamanho: fmtMB(antes) }));
}

/**
 * Apaga o histórico da conta. Primeiro o servidor, como `togglePublico`: um
 * pedido que falha não muda nada na tela.
 */
export async function limparHistorico(): Promise<void> {
  const ui = uiStore.getState();
  try {
    await historico.limpar();
  } catch (err) {
    console.warn('[ondas] não foi possível limpar o histórico:', err);
    ui.flash(t('semRede.historicoNaoLimpo'));
    return;
  }
  ui.flash(t('toast.historicoLimpo'));
}

export function toggleSimulatedOffline(): void {
  const ui = uiStore.getState();
  const next = !ui.simulatedOffline;
  ui.setSimulatedOffline(next);
  ui.flash(t(next ? 'toast.redeDesconectada' : 'toast.redeConectada'));
}

/**
 * Liga o motor de áudio às stores, restaura sessão e biblioteca e reconcilia o
 * índice offline com o que o aparelho realmente guardou. Devolve o cleanup.
 */
export function bootstrap(): () => void {
  const player = playerStore.getState();
  const ui = uiStore.getState();

  const offs = [
    engine.on('time', (t) => {
      playerStore.getState().patch({ t });
      setMediaPosition(t, playerStore.getState().dur);
    }),
    engine.on('duration', (dur) => playerStore.getState().patch({ dur })),
    engine.on('buffer', (buf) => playerStore.getState().patch({ buf })),
    engine.on('waiting', (waiting) => playerStore.getState().patch({ waiting })),
    engine.on('playing', (playing) => {
      // Som saindo = a sequência de falhas acabou, e ninguém mais espera rede.
      if (playing) {
        falhasSeguidas = 0;
        pendencia = null;
      }
      playerStore.getState().patch({ playing, waiting: false });
      setMediaPlaybackState(playing);
    }),
    engine.on('ended', () => {
      const action = onEnded(queueContext());
      if (action.type === 'restart') {
        engine.seek(0);
        void engine.play();
      } else if (action.type === 'play') {
        void tocarFaixa(action.index);
      } else {
        // Nada tocável à frente — hoje isso só acontece com a fila inteira
        // bloqueada, porque falta de rede deixou de bloquear faixa. Não arma
        // espera de rede: a rede voltar não desbloqueia faixa [pro].
        pararNaTela();
        ui.flash(t('toast.nadaParaTocar'));
      }
    }),
    engine.on('error', () => {
      falhasSeguidas += 1;
      if (falhasSeguidas >= LIMITE_DE_FALHAS) {
        // Aqui `isOffline()` ganha o papel que lhe cabe: não vetar playback,
        // só escolher o recado. Se o navegador diz que não há rede, a promessa
        // de retomar é honesta; se ele diz que há, o problema é outro.
        desistir(isOffline() ? 'toast.semRede' : 'toast.playerDesistiu');
        return;
      }
      ui.flash(t('toast.streamIndisponivel'));
      avancar(1);
    }),
    bindMediaSessionActions({
      // Pelo `togglePlay`/`step`, e não direto no engine: o botão da tela de
      // bloqueio é gesto da pessoa como qualquer outro, e precisa limpar o
      // que o automático armou.
      play: () => {
        if (engine.isPaused()) togglePlay();
      },
      pause: () => engine.pause(),
      next: () => step(1),
      prev: () => step(-1),
      seekTo: (seconds) => irPara(seconds),
      seekBy: (offset) => seekBy(offset),
    }),
    connectivity.subscribe((value) => {
      setOnline(value);
      ui.flash(t(value ? 'toast.redeConectada' : 'toast.redeDesconectada'));
      // A rede voltou: é a hora de subir o que foi curtido sem ela.
      if (value) void sincronizar();
      // E a posição e as faixas ouvidas sem ela.
      if (value) void historico.subirPendente();
      // E de retomar a música, se ela parou justamente por falta de rede.
      if (value && pendencia) void retomar('toast.retomando');
      // As playlists não têm fila para subir (ver `app/playlists.ts`), mas o
      // espelho pode ter perdido uma escrita recusada por falta de rede.
      if (value) void listas.carregarPlaylists();
    }),
    // O OUTRO momento de tentar de novo, e o que faltava em 2026-11-05: a
    // pendência nascia presa a um evento que a página em segundo plano não
    // recebe. Quando a tela acende, `navigator.onLine` já voltou a ser `true`
    // e nenhum `online` dispara por uma mudança ocorrida enquanto a página
    // estava parada — a música ficava esperando um aviso que nunca vinha.
    //
    // Só a pendência: `sincronizar` e `carregarPlaylists` ficam de fora, senão
    // cada foco de aba viraria dois pedidos à API.
    aoVoltarParaATela(() => {
      if (pendencia) void retomar('toast.continuando');
      // A exceção consciente à regra acima, e a única: o marcador. A PWA
      // instalada não "abre" — ela fica viva por dias —, e sem isto quem ouviu
      // no desktop pegaria o celular e veria a faixa de ontem. Os freios (só
      // parado, uma vez por minuto) estão em `historico.aoVoltar`.
      else void historico.aoVoltar();
    }),
    // A gravação do marcador e do histórico: observa a store do player.
    historico.ligar({ faixaAtual: currentTrack, armar, armadoEm }),
    // E o resto que só existe na memória, quando a página sai de cena.
    aoSairDaTela(() => historico.despejar()),
  ];
  setOnline(connectivity.isOnline());
  player.reset();

  return () => {
    for (const off of offs) off();
  };
}
