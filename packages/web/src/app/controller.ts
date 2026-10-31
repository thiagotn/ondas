import {
  faixaPorNumero,
  firstPlayable,
  fmtMB,
  indexOfTrack,
  offlineBytes,
  onEnded,
  playability,
  prefetchTarget,
  showsPublicCatalog,
  stepIndex,
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
import { applyTheme, storeTheme } from '../theme/applyTheme';
import { queryClient } from '../query/client';
import { CATALOG_LOGADO_KEY, catalogKey } from '../query/catalog';
import { ehCotaExcedida } from '../platform/CacheOfflineStore';
import { useAvulsas } from './extras';
import { esquecerCurtidas, registrar, sincronizar } from './likes';
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
  engine.seek(Math.min(1, Math.max(0, fraction)) * dur);
}

export function seekBy(seconds: number): void {
  const { t, dur } = playerStore.getState();
  if (!dur) return;
  engine.seek(Math.min(dur, Math.max(0, t + seconds)));
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
    uiStore.getState().flash('curtir exige entrar na conta');
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
  // A fila sobe ANTES de o cookie morrer. Curtir e sair em seguida é um gesto
  // só, e o debounce de `registrar` pode nem ter disparado ainda: depois do
  // `auth.logout()` o PATCH só levaria 401, e a curtida morreria no caminho.
  await sincronizar();
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
    ui.flash('não foi possível mudar o catálogo');
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
  // A semente é o acervo, e o rótulo `só o acervo` é verdade no instante em que
  // ela aparece: é só isso que está na tela. O `invalidateQueries` abaixo busca a
  // versão autoritativa por baixo, e o prompt diz `· atualizando` enquanto isso.
  const chaveNova = catalogKey(true, !ligado);
  if (!queryClient.getQueryData(chaveNova)) {
    const proprias = tracks.filter((t) => t.source === 'acervo');
    queryClient.setQueryData(chaveNova, {
      tracks: [...proprias],
      source: 'só o acervo',
      acervo: proprias.length,
    });
  }

  sessionStore.getState().setUser(novo);
  void queryClient.invalidateQueries({ queryKey: CATALOG_LOGADO_KEY });
  ui.flash('catálogo público → ' + (ligado ? 'desligado' : 'ligado'));
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
      // A rede voltou: é a hora de subir o que foi curtido sem ela.
      if (value) void sincronizar();
    }),
  ];
  setOnline(connectivity.isOnline());
  player.reset();

  return () => {
    for (const off of offs) off();
  };
}
