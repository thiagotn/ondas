import {
  faixaPorNumero,
  firstPlayable,
  fmtMB,
  indexOfTrack,
  offlineBytes,
  onEnded,
  playability,
  prefetchTarget,
  stepIndex,
  type QueueContext,
  type ThemeId,
  type Track,
} from '@ondas/core';
import {
  bindMediaSessionActions,
  setMediaMetadata,
  setMediaPlaybackState,
  setMediaPosition,
} from '../platform/mediaSession';
import { compartilhar } from '../platform/share';
import { applyTheme, storeTheme } from '../theme/applyTheme';
import { queryClient } from '../query/client';
import { catalogKey } from '../query/catalog';
import { ehCotaExcedida } from '../platform/CacheOfflineStore';
import { auth, connectivity, engine, offlineStore } from './services';
import { libraryStore, playerStore, sessionStore, uiStore } from './stores';

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

/** Offline de verdade, ou a simulação de rede do build de dev. */
export function isOffline(): boolean {
  return !online || (import.meta.env.DEV && uiStore.getState().simulatedOffline);
}

function queueContext(): QueueContext {
  const lib = libraryStore.getState();
  const player = playerStore.getState();
  return {
    tracks,
    session: sessionStore.getState().user,
    offline: isOffline(),
    cached: lib.cached,
    shuffle: player.shuffle,
    repeat: player.repeat,
    cur: player.cur,
  };
}

export function currentTrack(): Track | undefined {
  const { cur } = playerStore.getState();
  return cur >= 0 ? tracks[cur] : undefined;
}

export async function play(index: number): Promise<void> {
  const track = tracks[index];
  if (!track) return;
  const lib = libraryStore.getState();
  const ui = uiStore.getState();
  const verdict = playability(track, index, {
    session: sessionStore.getState().user,
    offline: isOffline(),
    cached: lib.cached,
  });
  if (!verdict.ok) {
    if (verdict.reason === 'locked') ui.openGate('play', track.title);
    else ui.flash('sem rede — faixa não está no aparelho');
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
    if (local) src = local;
    else if (isOffline()) src = '';
  } else if (!track.stream) {
    // Faixa demo: sem áudio, playback simulado.
    src = '';
  }

  engine.load(track, src);
  setMediaMetadata(track);
  await engine.play();

  if (lib.prefetch && sessionStore.getState().user) void prefetchNext(index);
}

export function togglePlay(): void {
  const player = playerStore.getState();
  if (player.cur < 0) {
    const first = firstPlayable(queueContext());
    if (first >= 0) void play(first);
    return;
  }
  if (engine.isPaused()) void engine.play();
  else engine.pause();
}

export function step(dir: 1 | -1): void {
  const next = stepIndex(queueContext(), dir);
  if (next >= 0) void play(next);
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
    ui.flash('faixa ' + numero + ' não existe');
    return undefined;
  }
  ui.setCursor(track.id);
  return track;
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
  engine.seek(Math.min(1, Math.max(0, fraction)) * dur);
}

export function seekBy(seconds: number): void {
  const { t, dur } = playerStore.getState();
  if (!dur) return;
  engine.seek(Math.min(dur, Math.max(0, t + seconds)));
}

export function toggleLike(id: string): void {
  libraryStore.getState().toggleLike(id);
}

export function likeCurrent(): void {
  const track = currentTrack();
  if (track) toggleLike(track.id);
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
    ui.flash('removida do aparelho');
    return;
  }
  if (lib.dl[track.id] != null) return;
  if (isOffline()) {
    ui.flash('conecte-se para baixar');
    return;
  }

  const done = (size: number) => {
    libraryStore.getState().setDl(track.id, null);
    libraryStore.getState().markCached(track.id, size);
    ui.flash(silent ? 'buffer: próxima faixa salva' : 'salva no aparelho');
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
      if (!silent) ui.flash('sem espaço no aparelho — limpe downloads em ondas whoami');
      return;
    }
    console.warn('[ondas] download falhou:', err);
    if (!silent) ui.flash('falha no download');
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
  uiStore.getState().flash('tema → ' + id);
}

export async function logout(): Promise<void> {
  await auth.logout();
  sessionStore.getState().setUser(null);
  // O catálogo do logado tem as faixas do acervo, e ele fica persistido em
  // IndexedDB. Sair sem apagar deixaria os metadados das faixas próprias no
  // aparelho à espera do próximo visitante.
  queryClient.removeQueries({ queryKey: catalogKey(true) });
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
  uiStore.getState().flash('downloads apagados — ' + fmtMB(antes) + ' liberados');
}

export function toggleSimulatedOffline(): void {
  const ui = uiStore.getState();
  const next = !ui.simulatedOffline;
  ui.setSimulatedOffline(next);
  ui.flash(next ? 'rede desconectada — apenas faixas [off]' : 'rede conectada');
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
      playerStore.getState().patch({ playing, waiting: false });
      setMediaPlaybackState(playing);
    }),
    engine.on('ended', () => {
      const action = onEnded(queueContext());
      if (action.type === 'restart') {
        engine.seek(0);
        void engine.play();
      } else if (action.type === 'play') {
        void play(action.index);
      } else {
        playerStore.getState().patch({ playing: false });
      }
    }),
    engine.on('error', () => {
      ui.flash('stream indisponível — pulando faixa');
      step(1);
    }),
    bindMediaSessionActions({
      play: () => void engine.play(),
      pause: () => engine.pause(),
      next: () => step(1),
      prev: () => step(-1),
      seekTo: (seconds) => engine.seek(seconds),
      seekBy: (offset) => seekBy(offset),
    }),
    connectivity.subscribe((value) => {
      setOnline(value);
      ui.flash(value ? 'rede conectada' : 'rede desconectada — apenas faixas [off]');
    }),
  ];
  setOnline(connectivity.isOnline());
  player.reset();

  return () => {
    for (const off of offs) off();
  };
}
