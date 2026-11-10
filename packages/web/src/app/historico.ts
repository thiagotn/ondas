import {
  HistoricoError,
  OBSERVADOR_VAZIO,
  comAFila,
  decidirRestauracao,
  enfileirarNoHistorico,
  leEspelho,
  leItensDoHistorico,
  maisNovo,
  marcadorDaAmostra,
  observar,
  posicaoDeRetomada,
  retratoDe,
  semOQueSubiuDoHistorico,
  type Amostra,
  type EspelhoDoMarcador,
  type EstadoDoObservador,
  type ItemDoHistorico,
  type Marcador,
  type Track,
} from '@ondas/core';
import { queryClient } from '../query/client';
import { useAvulsas } from './extras';
import { catalogClient, historicoClient, kv } from './services';
import { playerStore, sessionStore } from './stores';

/**
 * O marcador e o histórico da conta, do lado do aparelho.
 *
 * Irmão de `app/likes.ts`, e pelo mesmo desenho: o servidor é o dono, o
 * IndexedDB guarda um espelho para a tela não depender da rede, e o que não
 * subiu espera numa fila. A regra de QUANDO gravar não mora aqui — é
 * `observar`, no core, que este arquivo só alimenta com o que o player faz.
 *
 * Três coisas acontecem aqui:
 *
 * 1. **gravação** — cada mudança do `playerStore` vira uma amostra; o que o
 *    observador devolve vira escrita no espelho, PUT do marcador ou linha nova
 *    no histórico;
 * 2. **restauração** — no boot e no login, o marcador da conta vira uma faixa
 *    ARMADA no player: carregada na tela, pausada, sem áudio pedido;
 * 3. **esquecimento** — no logout e no 401, nada disto fica para a próxima
 *    conta que entrar neste navegador.
 */

/** O espelho do marcador: `{ marcador, pendente }`. */
export const MARCADOR_KEY = 'marcador';
/** As faixas ouvidas que ainda não subiram para o histórico. */
export const FILA_KEY = 'historico-fila';
/**
 * Igual a `HISTORICO_KEY` em `query/historico.ts`. Repetida, e não importada,
 * porque aquele arquivo importa este (o `queryFn` é `lerHistorico`).
 */
const CONSULTA = ['historico'] as const;

/** De quanto em quanto tempo a volta para a tela pode perguntar ao servidor. */
const VOLTA_A_CADA_MS = 60_000;

/**
 * O que este arquivo precisa do controller, entregue por `ligar`.
 *
 * Por injeção, e não por `import`, para o grafo continuar sem ciclo: o
 * controller chama este arquivo (logout, rede, boot), e o contrário passaria a
 * depender da ordem em que os módulos são avaliados.
 */
export interface Player {
  /** A faixa que está no player, para tirar o retrato dela. */
  faixaAtual(): Track | undefined;
  /** Põe a faixa no player, pausada na posição. `false` se não coube. */
  armar(id: string, pos: number): boolean;
  /** O id da faixa armada e ainda intocada, ou `null`. */
  armadoEm(): string | null;
}

let player: Player | null = null;
let estado: EstadoDoObservador = OBSERVADOR_VAZIO;
let espelho: EspelhoDoMarcador | null = null;
let fila: ItemDoHistorico[] | null = null;

/** Só sessão grava: visitante não tem conta onde guardar. */
const logado = (): boolean => !!sessionStore.getState().user;

function amostra(): Amostra {
  const { curId, t, dur, playing, waiting } = playerStore.getState();
  return { curId, t, dur, playing, waiting, agora: Date.now() };
}

// ---------------------------------------------------------------- gravação

/**
 * Liga o observador ao player. Chamada uma vez, pelo `bootstrap`.
 *
 * Assina a store em vez de espalhar ganchos pelo controller: tudo o que muda o
 * player passa por ela — o tick do áudio, o pause, o seek, a troca de faixa —,
 * e um gancho por caminho seria uma lista que alguém esquece de completar.
 */
export function ligar(p: Player): () => void {
  player = p;
  estado = OBSERVADOR_VAZIO;
  return playerStore.subscribe(() => {
    const a = amostra();
    const r = observar(estado, a);
    estado = r.estado;
    // TODA escrita passa por aqui, inclusive a do espelho. O player segue
    // tocando depois de sair da conta, e sem esta linha o que se ouve deslogado
    // iria para o disco — e de lá para a conta de quem entrasse depois.
    if (!r.efeitos.length || !logado()) return;

    if (r.efeitos.includes('espelhar')) {
      const m = marcadorDaAmostra(a);
      if (m) espelhar({ marcador: m, pendente: true });
    }
    if (r.efeitos.includes('subir')) void subirMarcador();
    if (r.efeitos.includes('contar')) {
      const track = player?.faixaAtual();
      if (track && track.id === a.curId) void contar(retratoDe(track, a.agora));
    }
  });
}

function espelhar(novo: EspelhoDoMarcador): void {
  espelho = novo;
  void kv.set(MARCADOR_KEY, novo);
}

let subindo: Promise<void> | null = null;
let deNovo = false;
/**
 * A próxima subida vai com `keepalive`. Fica fora do argumento porque o pedido
 * de despejo pode chegar com outra subida em voo: quem roda em seguida é o
 * laço daquela, e ele precisa saber que a página está saindo de cena.
 */
let comKeepalive = false;

/**
 * Manda o marcador pendente para a conta.
 *
 * Uma subida de cada vez. A que chega com outra em voo não é descartada: fica
 * anotada e roda em seguida — é o caso do pause que cai no meio do PUT dos
 * quinze segundos, e perdê-lo seria perder justamente a posição final.
 */
function subirMarcador(opts?: { keepalive?: boolean }): Promise<void> {
  if (!logado() || !espelho?.pendente) return Promise.resolve();
  if (opts?.keepalive) comKeepalive = true;
  if (subindo) {
    deNovo = true;
    return subindo;
  }
  subindo = (async () => {
    do {
      deNovo = false;
      const enviado: Marcador | null = espelho?.pendente ? espelho.marcador : null;
      if (!enviado || !logado()) return;
      const keepalive = comKeepalive;
      comKeepalive = false;
      try {
        await historicoClient.gravarMarcador(enviado, keepalive ? { keepalive } : undefined);
        // Só deixa de estar pendente se o espelho ainda é o que subiu: o que a
        // pessoa ouviu durante o voo é posição nova, e continua por subir.
        //
        // A resposta — o marcador que FICOU no servidor — não é aplicada: se
        // outro aparelho venceu, este aqui está tocando agora, e a próxima
        // escrita dele sai com um carimbo mais novo e vence de volta.
        if (espelho?.marcador.em === enviado.em) espelhar({ marcador: enviado, pendente: false });
      } catch (err) {
        // Só o 401 invalida, pelo critério de `app/likes.ts`: falta de rede
        // não é o servidor dizendo não. O espelho fica pendente e a próxima
        // chamada — o tick seguinte, ou a rede voltando — tenta de novo.
        if (err instanceof HistoricoError && err.semSessao) await esquecer();
        return;
      }
    } while (deNovo);
  })().finally(() => {
    subindo = null;
  });
  return subindo;
}

/**
 * A página está saindo de cena: grava o que só existe na memória.
 *
 * O espelho é regravado a cada cinco segundos de música e o servidor a cada
 * quinze; fechar a aba no meio do intervalo perderia esse resto. `keepalive` é
 * o que deixa o pedido terminar depois de a página morrer.
 *
 * Com o player armado, ou parado desde a última gravação, não há resto nenhum
 * e isto não escreve — o aparelho que só foi aberto e fechado não deixa rastro.
 */
export function despejar(): void {
  if (!logado()) return;
  if (estado.tocou && estado.sujo) {
    const a = amostra();
    const m = marcadorDaAmostra(a);
    if (m) {
      espelhar({ marcador: m, pendente: true });
      estado = { ...estado, sujo: false, espelhadoEm: a.agora, subidoEm: a.agora };
    }
  }
  void subirMarcador({ keepalive: true });
}

// --------------------------------------------------------------- histórico

async function filaAtual(): Promise<ItemDoHistorico[]> {
  if (!fila) fila = leItensDoHistorico(await kv.get(FILA_KEY));
  return fila;
}

async function gravarFila(nova: ItemDoHistorico[]): Promise<void> {
  fila = nova;
  await kv.set(FILA_KEY, nova);
}

/**
 * A faixa passou do limiar: entra no histórico.
 *
 * Na tela ela aparece na hora, pela consulta, e sobe em seguida. A fila é o
 * que compra esse otimismo, como nas curtidas — sem rede a linha fica
 * guardada e sobe quando der.
 */
async function contar(item: ItemDoHistorico): Promise<void> {
  await gravarFila(enfileirarNoHistorico(await filaAtual(), item));
  queryClient.setQueryData<ItemDoHistorico[]>(CONSULTA, (antes) => comAFila(antes ?? [], [item]));
  await subirHistorico();
}

let subindoHistorico: Promise<void> | null = null;

function subirHistorico(): Promise<void> {
  if (!logado()) return Promise.resolve();
  if (subindoHistorico) return subindoHistorico;
  subindoHistorico = (async () => {
    const enviada = await filaAtual();
    if (!enviada.length) return;
    try {
      const servidor = await historicoClient.registrar(enviada);
      // A fila só perde o que de fato subiu: o que entrou durante o voo fica.
      const sobrou = semOQueSubiuDoHistorico(fila ?? [], enviada);
      await gravarFila(sobrou);
      queryClient.setQueryData<ItemDoHistorico[]>(CONSULTA, comAFila(servidor, sobrou));
      if (sobrou.length) queueMicrotask(() => void subirHistorico());
    } catch (err) {
      if (err instanceof HistoricoError && err.semSessao) await esquecer();
    }
  })().finally(() => {
    subindoHistorico = null;
  });
  return subindoHistorico;
}

/** O `queryFn` de `useHistorico`: o servidor com a fila por cima. */
export async function lerHistorico(signal?: AbortSignal): Promise<ItemDoHistorico[]> {
  try {
    return comAFila(await historicoClient.listar(signal), await filaAtual());
  } catch (err) {
    if (err instanceof HistoricoError && err.semSessao) await esquecer();
    throw err;
  }
}

/**
 * Apaga o histórico da conta. Primeiro o servidor, como `togglePublico`: um
 * DELETE que falha não muda nada na tela, e quem chama avisa.
 *
 * O marcador fica — "esquecer o que ouvi" não é "perder onde parei".
 */
export async function limpar(): Promise<void> {
  await historicoClient.limpar();
  await gravarFila([]);
  queryClient.setQueryData<ItemDoHistorico[]>(CONSULTA, []);
}

/**
 * Sobe o que estiver por subir. Chamada antes do logout — depois de
 * `auth.logout()` o pedido só levaria 401 — e quando a rede volta.
 */
export async function subirPendente(): Promise<void> {
  await subirMarcador();
  await subirHistorico();
}

// ------------------------------------------------------------- restauração

/** O marcador que a restauração vai usar: o espelho, ou o do servidor se mais novo. */
let candidato: Marcador | null = null;
/** A restauração deste boot (ou deste login) já foi decidida. */
let resolvido = true;
/** O id que já se tentou buscar fora da lista — uma tentativa só. */
let buscando: string | null = null;
let faixas: readonly Track[] = [];
let deeplink = false;
let atualizando = false;
let ultimaVolta = 0;

/**
 * Começa a restauração: lê o espelho e pergunta ao servidor.
 *
 * Chamada no fim do `hydrate` (boot) e depois do login. Nenhuma das duas
 * espera por ela: o espelho arma o player sem rede, e o servidor corrige
 * depois se tiver coisa mais nova.
 */
export async function iniciar(opts?: { novaSessao?: boolean }): Promise<void> {
  // Depois do login a lista que este arquivo conhece é a de ANTES dele — a do
  // visitante, ou a da conta anterior. Decidir com ela concluiria que a faixa
  // do acervo desta conta "não existe". A lista certa chega pelo `AppLayout`.
  if (opts?.novaSessao) {
    faixas = [];
    // E a consulta do histórico que estiver no cache é de quem usou este
    // navegador antes. O `esquecer()` do boot roda cedo demais para pegá-la
    // quando a sessão caiu sozinha: o cache persistido só é reidratado depois.
    queryClient.removeQueries({ queryKey: CONSULTA });
  }
  if (!logado()) {
    // Sessão que caiu (o `restore()` levou 401) deixa o espelho de quem saiu
    // no disco, sem ninguém ter clicado em `[sair]`. Se ficasse, a próxima
    // conta a entrar aqui herdaria a faixa — e, com `pendente`, a gravaria
    // como sua.
    await esquecer();
    return;
  }
  resolvido = false;
  buscando = null;
  candidato = null;
  // A volta para a tela não precisa perguntar de novo logo em seguida.
  ultimaVolta = Date.now();

  espelho = leEspelho(await kv.get(MARCADOR_KEY));
  if (espelho) {
    candidato = espelho.marcador;
    restaurar();
  }

  let servidor: Marcador | null;
  try {
    servidor = await historicoClient.marcador();
  } catch (err) {
    if (err instanceof HistoricoError && err.semSessao) await esquecer();
    // Sem rede: vale o espelho, que já foi usado acima.
    return;
  }
  adotarDoServidor(servidor);
  // O que este aparelho ouviu sem rede e ainda não subiu.
  void subirPendente();
}

/**
 * O servidor respondeu. Se ele tem coisa mais nova que o aparelho, é ela que
 * vale — e o player armado com o espelho é rearmado, se ninguém tocou nele.
 */
function adotarDoServidor(servidor: Marcador | null): void {
  if (!servidor) {
    // Conta sem marcador, e aparelho sem espelho: não há o que restaurar.
    if (!candidato) resolvido = true;
    return;
  }
  if (candidato && !maisNovo(servidor, candidato)) return;
  candidato = servidor;
  espelhar({ marcador: servidor, pendente: false });
  // Rearmar só vale se o que está no player é o que a restauração pôs lá.
  if (resolvido && player?.armadoEm() == null) return;
  resolvido = false;
  restaurar();
}

/**
 * A lista de faixas mudou — ou chegou. É aqui que a restauração acontece de
 * fato, porque só com a lista dá para saber se a faixa do marcador existe.
 *
 * `deeplink` é a faixa pedida pela URL (`/t/...`), e vence o marcador.
 * `atualizando` diz que a lista veio do cache e a de verdade está a caminho.
 */
export function aoMudarFaixas(
  next: readonly Track[],
  opts: { deeplink: boolean; atualizando: boolean },
): void {
  faixas = next;
  deeplink = opts.deeplink;
  atualizando = opts.atualizando;
  restaurar();
}

function restaurar(): void {
  if (resolvido || !player || !logado() || !candidato || !faixas.length) return;
  const { curId } = playerStore.getState();
  // A faixa armada pela própria restauração não conta como "player ocupado":
  // é o que deixa o marcador do servidor substituir o do espelho.
  const ocupado = curId !== null && curId !== player.armadoEm();
  const decisao = decidirRestauracao({
    marcador: candidato,
    curId: ocupado ? curId : null,
    deeplink,
    ids: new Set(faixas.map((f) => f.id)),
    atualizando,
  });

  // A lista de verdade está a caminho; a próxima chamada decide.
  if (decisao === 'esperar') return;
  if (decisao === 'nada') {
    resolvido = true;
    return;
  }
  if (decisao === 'armar') {
    resolvido = true;
    armar(candidato);
    return;
  }
  // `buscar`: faixa pública que saiu do trending. Uma tentativa — se voltar,
  // ela entra como avulsa, a lista muda e este mesmo caminho a arma.
  if (buscando === candidato.trackId) return;
  buscando = candidato.trackId;
  const id = candidato.trackId;
  void catalogClient.track!(id)
    .then((track) => {
      if (track && candidato?.trackId === id) useAvulsas.getState().add(track);
      else resolvido = true;
    })
    .catch((err: unknown) => {
      // Sem toast: a pessoa não pediu nada, e "não consegui retomar uma faixa
      // que você nem lembrava" não é recado que valha interromper.
      console.warn('[ondas] faixa do marcador indisponível:', err);
      resolvido = true;
    });
}

function armar(m: Marcador): void {
  // O observador recomeça do zero ANTES de a faixa entrar no player. Sem isto,
  // rearmar a mesma faixa numa posição diferente pareceria um seek — e este
  // aparelho, parado, regravaria como sua a posição que acabou de receber.
  estado = { ...OBSERVADOR_VAZIO, espelhadoEm: estado.espelhadoEm, subidoEm: estado.subidoEm };
  player?.armar(m.trackId, posicaoDeRetomada(m.pos, m.dur));
}

/**
 * A página voltou para a frente da pessoa.
 *
 * Existe porque PWA instalada não "abre": ela fica viva por dias no celular, e
 * quem ouviu no desktop e pegou o telefone veria a faixa de ontem. É a única
 * coisa neste app que fala com a API por foco de aba (o `bootstrap` explica
 * por que curtidas e playlists não falam), e por isso tem três freios: só com
 * o player parado, no máximo uma vez por minuto, e só troca o que está na tela
 * se o servidor tiver coisa MAIS NOVA do que este aparelho conhece.
 */
export async function aoVoltar(): Promise<void> {
  if (!logado() || !player) return;
  const { playing, waiting } = playerStore.getState();
  if (playing || waiting) return;
  const agora = Date.now();
  if (agora - ultimaVolta < VOLTA_A_CADA_MS) return;
  ultimaVolta = agora;

  let servidor: Marcador | null;
  try {
    servidor = await historicoClient.marcador();
  } catch (err) {
    if (err instanceof HistoricoError && err.semSessao) await esquecer();
    return;
  }
  if (!servidor || (espelho && !maisNovo(servidor, espelho.marcador))) return;
  // A resposta demorou e a pessoa já deu play: o que ela escolheu vale mais.
  const depois = playerStore.getState();
  if (depois.playing || depois.waiting) return;
  if (!faixas.some((f) => f.id === servidor.trackId)) return;
  // Com o player cheio aberto, a URL É a faixa (`/t/...`). Trocar a faixa por
  // baixo dela deixaria o endereço apontando para uma música e o player para
  // outra — ali só a POSIÇÃO da mesma faixa é atualizada.
  if (deeplink && servidor.trackId !== depois.curId) return;
  espelhar({ marcador: servidor, pendente: false });
  candidato = servidor;
  armar(servidor);
}

// ------------------------------------------------------------ esquecimento

/**
 * Esquece o que é da conta que saiu: o espelho, a fila e a consulta.
 *
 * Vale para o clique em `[sair]` e para o 401, que é a mesma situação sem o
 * clique. Apagar é seguro porque está tudo no servidor — entrar de novo traz.
 * O que NÃO está (a posição dos últimos segundos, uma faixa na fila) é o que
 * `subirPendente` leva antes de o logout chamar isto.
 */
export async function esquecer(): Promise<void> {
  espelho = null;
  fila = [];
  candidato = null;
  resolvido = true;
  buscando = null;
  estado = { ...OBSERVADOR_VAZIO, curId: estado.curId, t: estado.t, playing: estado.playing };
  await kv.remove(MARCADOR_KEY);
  await kv.remove(FILA_KEY);
  queryClient.removeQueries({ queryKey: CONSULTA });
}
