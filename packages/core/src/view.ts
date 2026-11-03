import { fmtBytes, fmtTime } from './format.js';
import { t as traduzir } from './i18n/index.js';
import type { Catalog, CatalogSource, LibrarySegment, Session, TabId, Track } from './types.js';

/**
 * Os cinco recortes da biblioteca, na ordem em que a tela os mostra.
 *
 * `acervo` fica no MEIO e não no fim: ele é o padrão de quem tem conta
 * (`defaultLibrarySegment`), e o padrão no canto direito faz a tela abrir com o
 * chip mais distante marcado.
 *
 * `playlists` encosta em `liked` porque os dois são ESCOLHA de quem ouve, e os
 * outros três não são — `acervo` e `shared` são procedência da faixa, `offline`
 * é o que está neste aparelho. `shared` encosta em `acervo` porque é a mesma
 * origem vista do outro lado, e `offline` continua por último.
 *
 * `playlists` é o único que NÃO lista faixas: `/library/playlists` é o índice
 * das playlists, e `/library/playlists/<id>` são as faixas de uma delas. Ele
 * entra nesta lista de todo jeito porque é daqui que saem a fileira de chips e
 * a peneira do que vem pela URL — mantê-lo fora exigiria uma segunda fonte para
 * as duas coisas.
 *
 * Aqui, e não na tela: eles viraram endereço (`/library/offline`), e o que
 * entra pela URL é texto de fora — precisa de uma peneira testável. A tela só
 * mapeia esta lista (`LibraryRoute`), então mudar a ordem é mudar esta linha.
 */
export const LIBRARY_SEGMENTS: readonly LibrarySegment[] = [
  'liked',
  'playlists',
  'acervo',
  'shared',
  'offline',
];

/**
 * A palavra de cada recorte na URL.
 *
 * Duas delas são o próprio id; `acervo` vira `archive` porque todo path do app
 * é inglês. O id NÃO acompanha: ele é o mesmo valor que a API emite em
 * `Track.source` (`api/internal/httpapi/acervo.go`) e que o chip `--acervo`
 * anuncia na tela — traduzir o id para casar com a URL exigiria traduzir os
 * dois, e um deles não é nosso.
 */
const SEGMENT_SLUGS: Record<LibrarySegment, string> = {
  liked: 'liked',
  playlists: 'playlists',
  offline: 'offline',
  acervo: 'archive',
  shared: 'shared',
};

/** Recorte → a palavra dele na URL. */
export function librarySegmentSlug(seg: LibrarySegment): string {
  return SEGMENT_SLUGS[seg];
}

/**
 * A palavra de cada recorte NA TELA — o chip e a linha do prompt.
 *
 * Separada de `SEGMENT_SLUGS` porque são duas coisas: a URL é um id estável e
 * o chip é palavra de interface, que muda com o idioma. Enquanto o mapa era de
 * uma língua só isso ficava num objeto aqui; agora mora no catálogo, e a URL
 * continua parada — ela casa com `Track.source`, que a API Go emite.
 */
/** Recorte → a palavra dele na tela (`--curtidas`, `--liked`, `--megusta`…). */
export function librarySegmentChip(seg: LibrarySegment): string {
  return traduzir(`recorte.${seg}`);
}

/**
 * O recorte que `/library` sem segmento significa.
 *
 * Com conta é `acervo`: a biblioteca é onde ficam as faixas que são da pessoa,
 * e é o recorte que o envio alimenta — abrir em `--curtidas` pedia um clique
 * antes de mostrar o que ela tem. Sem conta o acervo não existe: o catálogo não
 * traz faixa própria nenhuma e o chip nem é desenhado (`LibraryRoute`), então
 * ali o padrão volta a ser `liked`.
 *
 * Desde que a curtida passou a morar na conta, `liked` sem sessão não é mais
 * "o que vive no aparelho e não pede servidor" — os QUATRO recortes pedem
 * conta, e `~/biblioteca` inteira é uma porta fechada para quem não entrou.
 * `liked` continua sendo o padrão por ser o primeiro chip, não por ser o que
 * funciona.
 *
 * Aqui, e não na tela, porque é a mesma regra que decide duas coisas: onde
 * `/library` abre e onde cai um segmento que não existe.
 */
export function defaultLibrarySegment(user: Session): LibrarySegment {
  return user ? 'acervo' : 'liked';
}

/**
 * Se o catálogo público entra na lista.
 *
 * Visitante: sempre. Ele não tem conta onde guardar a escolha, e o catálogo
 * público é a única fonte que existe para ele.
 *
 * Com conta, é o campo `publico` do usuário — lido como `!== false`, e não como
 * `=== true`. A diferença é o caso que importa: `restore()` devolve o espelho
 * local sem validar quando não há rede, e um espelho gravado antes deste campo
 * existir não o tem. Com `=== true`, esse `undefined` apagaria o catálogo
 * público de quem nunca pediu isso, justamente offline, onde não há como
 * corrigir. Um `true` errado custa um toque; um `false` errado esconde o
 * catálogo E as faixas públicas curtidas e baixadas, sem causa visível.
 *
 * Aqui, e não na tela, porque é o único lugar que decide: a chave da consulta,
 * a fonte do catálogo, a linha do prompt e os textos de vazio leem desta função.
 */
export function showsPublicCatalog(user: Session): boolean {
  return user ? user.publico !== false : true;
}

/**
 * Quantos itens o recorte guarda no aparelho mas a lista não mostra.
 *
 * `--curtidas` e `--offline` filtram o catálogo carregado, então uma faixa
 * pública curtida ou baixada sai da tela quando a conta desliga o catálogo
 * público — o estado continua salvo, e os bytes também. Este número é o que
 * deixa o texto de vazio dizer isso em vez de mentir "vazio — baixe faixas".
 */
export function hiddenInSegment(
  seg: LibrarySegment,
  marks: Pick<ListQuery, 'liked' | 'cached' | 'playlist'>,
  tracks: readonly Track[],
): number {
  // `acervo` e `shared` não guardam marca no aparelho: os dois são filtros pela
  // procedência da faixa, e o que não está na lista não está em lugar nenhum.
  if (seg === 'acervo' || seg === 'shared') return 0;
  const naLista = new Set(tracks.map((t) => t.id));
  // A playlist é o terceiro caso, e o único cuja ausência NÃO depende do
  // catálogo público estar desligado: id guardado no servidor aponta para faixa
  // que pode ter saído do trending desde que foi salva. Quem lê este número
  // precisa saber disso — ver `emptyText`.
  const ids =
    seg === 'playlists'
      ? (marks.playlist ?? [])
      : Object.keys(seg === 'liked' ? marks.liked : marks.cached);
  return ids.filter((id) => !naLista.has(id)).length;
}

/**
 * Palavra da URL → recorte da biblioteca; o que não é uma das quatro vale
 * `padrao` — na tela, o de `defaultLibrarySegment`.
 *
 * Normaliza em silêncio em vez de dar tela de erro: `/library/lixo` é um
 * endereço digitado errado, não uma falha a explicar. O que ele NÃO pode fazer
 * é atravessar para dentro do app — sem isto, `promptLine` escreveria
 * `ondas ls --lixo` no prompt e a lista mostraria o recorte errado. Pela mesma
 * régua, `/library/acervo` (a palavra velha) cai no padrão: paths em português
 * não redirecionam, eles simplesmente não existem mais.
 */
export function parseLibrarySegment(
  raw: string | undefined,
  padrao: LibrarySegment,
): LibrarySegment {
  return LIBRARY_SEGMENTS.find((seg) => SEGMENT_SLUGS[seg] === raw) ?? padrao;
}

/** `tudo` + até 8 gêneros presentes no catálogo, na ordem em que aparecem. */
export function genreOptions(tracks: readonly Track[]): string[] {
  return ['tudo', ...[...new Set(tracks.map((t) => t.genre))].slice(0, 8)];
}

export interface ListQuery {
  tracks: readonly Track[];
  tab: TabId;
  q: string;
  genre: string;
  seg: LibrarySegment;
  liked: Readonly<Record<string, boolean>>;
  cached: Readonly<Record<string, boolean>>;
  /**
   * Os ids da playlist aberta, NA ORDEM dela. Ausente fora de uma playlist.
   *
   * É um array e não um mapa justamente por isso: aqui a ordem é o conteúdo da
   * informação, e `liked`/`cached` só respondem "está?".
   */
  playlist?: readonly string[];
}

/** A lista visível na aba atual. Busca casa título + artista + gênero, ignorando `#` inicial. */
export function visibleTracks(v: ListQuery): Track[] {
  if (v.tab === 'home') {
    return v.tracks.filter((t) => v.genre === 'tudo' || t.genre === v.genre);
  }
  if (v.tab === 'search') {
    const q = v.q.trim().toLowerCase().replace(/^#/, '');
    if (!q) return v.tracks.slice(0, 8);
    return v.tracks.filter((t) => `${t.title} ${t.artist} ${t.genre}`.toLowerCase().includes(q));
  }
  // `acervo` e `shared` não olham estado local: curtida e offline são marcas que
  // o aparelho guarda, e estes dois são sobre a PROCEDÊNCIA da faixa, posta
  // pelo adaptador em `catalog/acervo.ts`.
  //
  // O que separa os dois é `owner`, que a API só manda quando a faixa NÃO é de
  // quem pediu. Daí a divisão ser exaustiva: toda faixa do acervo cai em um dos
  // dois recortes, e em nenhum dos dois duas vezes.
  if (v.seg === 'acervo') return v.tracks.filter((t) => t.source === 'acervo' && !t.owner);
  if (v.seg === 'shared') return v.tracks.filter((t) => t.source === 'acervo' && !!t.owner);
  // A playlist é o ÚNICO recorte que não é um filtro sobre a lista: ela percorre
  // os próprios ids, e por isso sai NA ORDEM DELA e não na do catálogo. Filtrar
  // `v.tracks` daria as mesmas faixas na ordem errada — e a ordem é o que
  // distingue uma playlist de uma pilha de curtidas.
  //
  // Id sem faixa carregada é descartado em silêncio aqui; quem conta quantos
  // são é `hiddenInSegment`, para o texto de vazio poder dizer.
  if (v.seg === 'playlists') {
    const porID = new Map(v.tracks.map((t) => [t.id, t]));
    return (v.playlist ?? []).map((id) => porID.get(id)).filter((t): t is Track => t !== undefined);
  }
  return v.tracks.filter((t) => (v.seg === 'liked' ? v.liked[t.id] : v.cached[t.id]));
}

export interface PromptLine {
  who: string;
  cwd: string;
  cmd: string;
  comment: string;
}

/** A linha de prompt e o comentário `#` de cada aba. */
export function promptLine(args: {
  tab: TabId;
  who: string;
  genre: string;
  q: string;
  seg: LibrarySegment;
  count: number;
  source: Catalog['source'] | '';
  /**
   * O nome da playlist aberta. Ausente em `--playlists` significa o ÍNDICE das
   * playlists, que é outra tela — e por isso outra linha de prompt.
   */
  playlistNome?: string;
  /** Itens da playlist que não estão no catálogo (`hiddenInSegment`). */
  fora?: number;
  /** Quantas faixas próprias entraram na lista (ver `Catalog.acervo`). */
  acervo?: number;
  /** Há um refetch em andamento: o que está na tela ainda é o dado anterior. */
  refreshing?: boolean;
}): PromptLine {
  const { tab, who, genre, q, seg, count, source, acervo, refreshing } = args;
  const { playlistNome, fora } = args;
  if (tab === 'search') {
    const typed = q.trim().replace(/^#/, '');
    return {
      who,
      cwd: traduzir('cwd.search'),
      cmd: traduzir('cmd.search') + ' ' + (q ? `"${q}"` : ''),
      comment: typed ? traduzir('prompt.resultados', { n: count }) : traduzir('prompt.sugestoes'),
    };
  }
  if (tab === 'library') {
    // A playlist aberta é a única tela da biblioteca cujo comando leva um
    // argumento, e a única que precisa confessar o que não está ali: id
    // guardado no servidor pode apontar para faixa que saiu do catálogo.
    if (seg === 'playlists' && playlistNome) {
      return {
        who,
        cwd: traduzir('cwd.library'),
        cmd: traduzir('cmd.lsPlaylist', { nome: playlistNome }),
        comment:
          traduzir('prompt.itens', { n: count }) +
          (fora ? ' · ' + traduzir('prompt.foraDaLista', { n: fora }) : ''),
      };
    }
    return {
      who,
      cwd: traduzir('cwd.library'),
      cmd: traduzir('cmd.ls', { recorte: librarySegmentChip(seg) }),
      // O índice das playlists conta playlists, e não itens: dizer "3 itens"
      // numa tela de três playlists com trinta faixas seria uma meia-verdade.
      comment:
        seg === 'playlists'
          ? traduzir('prompt.playlists', { n: count })
          : traduzir('prompt.itens', { n: count }),
    };
  }
  return {
    who,
    cwd: traduzir('cwd.home'),
    cmd: traduzir('cmd.trending', { genero: genre }),
    // Enquanto o refetch não volta, a lista na tela é a da sessão anterior:
    // dizer "ao vivo" sem ressalva seria mentira. E quando o acervo entra, a
    // fonte deixa de ser uma só — dizer apenas "audius" esconderia metade.
    //
    // Com a origem `acervo` a contagem NÃO é anexada: ela já é o número à
    // esquerda, e `fonte: só o acervo (13)` em `13 faixas` seria a mesma conta duas
    // vezes. O `+ acervo (N)` existe para dizer quanto da lista misturada vem
    // do acervo, e aqui não há mistura.
    //
    // "do acervo" e não "é próprio": desde que existe faixa compartilhada, o
    // número conta as minhas MAIS as de outra pessoa que eu posso ouvir. As
    // duas vêm da mesma rota e as duas são o que o catálogo público não é — que
    // é o que esta contagem está dizendo.
    comment:
      traduzir('prompt.faixas', { n: count }) +
      ' · ' +
      traduzir('prompt.fonte', {
        fonte: source ? catalogSourceLabel(source) : traduzir('prompt.fonteDesconhecida'),
      }) +
      (acervo && source !== 'acervo' ? ' ' + traduzir('prompt.maisAcervo', { n: acervo }) : '') +
      (refreshing ? ' · ' + traduzir('prompt.atualizando') : ''),
  };
}

/**
 * Código da origem do catálogo → a frase que vai depois de `fonte: `.
 *
 * Existe porque `CatalogSource` deixou de ser a própria frase: a comparação em
 * `promptLine` precisa de um valor estável, e a tela precisa de uma frase que
 * muda com o idioma. Um mapa separa as duas coisas.
 */
export function catalogSourceLabel(source: CatalogSource): string {
  return traduzir(`fonte.${source}`);
}

/**
 * Texto de lista vazia, por aba e contexto de sessão.
 *
 * `hidden` e `publicOff` existem para a lista vazia não contradizer o resto da
 * tela: com o catálogo público desligado, `ondas whoami` continua dizendo
 * "7 faixas · 54 MB" (ele conta o estado do aparelho, não o catálogo) enquanto
 * `--offline` mostraria "vazio — baixe faixas [d]". A frase tem de dizer o que
 * aconteceu de verdade.
 */
/**
 * Chrome que as frases de lista vazia citam pelo nome.
 *
 * Mora aqui, e não dentro da tradução, porque é o MESMO botão nos três
 * idiomas: `ondas whoami` é o rótulo da janela de conta e `[+ arquivo]` é o
 * texto do botão. Digitá-los no catálogo deixaria a frase em espanhol
 * mandando apertar um botão que não existe com esse nome.
 */
const JANELA_CONTA = 'ondas whoami';
const BOTAO_ARQUIVO = '+ arquivo';
const BOTAO_PLAYLIST = '+ playlist';

export function emptyText(args: {
  tab: TabId;
  seg: LibrarySegment;
  q: string;
  loading: boolean;
  user: Session;
  /** O catálogo público está desligado nesta conta (`showsPublicCatalog`). */
  publicOff?: boolean;
  /** Itens do recorte que estão no aparelho mas fora da lista (`hiddenInSegment`). */
  hidden?: number;
  /**
   * Há uma playlist ABERTA, e não o índice delas. Os dois são `--playlists` e
   * dizem coisas opostas quando estão vazios: um não tem playlist nenhuma, o
   * outro tem uma playlist sem faixas.
   */
  playlistAberta?: boolean;
}): string {
  const { tab, seg, q, loading, user, publicOff, hidden, playlistAberta } = args;
  if (tab === 'search') return traduzir('vazio.busca', { termo: q });
  if (tab === 'library') {
    // O recorte tem coisa guardada, e ela está fora da lista porque o catálogo
    // público saiu — não porque não há nada.
    if (publicOff && hidden) {
      // O nome da janela entra como PARÂMETRO e nunca digitado na tradução:
      // é chrome citado dentro de prosa, e os três idiomas têm de apontar
      // para o mesmo botão.
      return traduzir('vazio.publicoDesligado', { n: hidden, janelaConta: JANELA_CONTA });
    }
    // Sem conta a frase não pode mandar apertar [l]: o coração não liga mais
    // para quem não entrou, porque a curtida é da conta e não do aparelho.
    if (seg === 'liked') {
      return traduzir(user ? 'vazio.curtidas' : 'vazio.curtidasSemConta');
    }
    if (seg === 'acervo') {
      return user
        ? traduzir('vazio.acervo', { botaoArquivo: BOTAO_ARQUIVO })
        : traduzir('vazio.acervoSemConta');
    }
    // As playlists ficam DEPOIS do ramo de `publicOff` acima de propósito: com
    // o catálogo público desligado, "religue em [ondas whoami]" é mais útil que
    // explicar o decaimento, porque é a frase que tem conserto.
    if (seg === 'playlists') {
      if (!user) return traduzir('vazio.playlistsSemConta');
      // Playlist aberta e vazia na tela, mas com itens guardados: eles são de
      // faixa pública que saiu do catálogo. Sem esta frase a tela mostraria uma
      // playlist vazia que o índice jura ter 7 faixas.
      if (playlistAberta && hidden) {
        return traduzir('vazio.playlistDecaida', { n: hidden, home: traduzir('cwd.home') });
      }
      // Estas duas frases são o único lugar da tela que ENSINA o gesto. Desde
      // que o botão saiu (ele custava uma linha inteira acima da lista), marcar
      // é segurar a faixa ou teclar `v`, e nada mais anuncia isso para quem só
      // toca — a janela `?` não tem porta no toque.
      return playlistAberta
        ? traduzir('vazio.playlistAberta', { botaoPlaylist: BOTAO_PLAYLIST })
        : traduzir('vazio.nenhumaPlaylist');
    }
    // A quarta porta fechada, na forma das outras três. Com conta a frase não
    // manda fazer nada: compartilhar não é ato de quem recebe.
    if (seg === 'shared') {
      return traduzir(user ? 'vazio.compartilhadas' : 'vazio.compartilhadasSemConta');
    }
    return traduzir(user ? 'vazio.offline' : 'vazio.offlineSemConta');
  }
  if (loading) return '';
  // em-alta vazia com o catálogo público desligado não é "nenhuma faixa": é o
  // acervo ainda vazio. A frase genérica mandaria a pessoa procurar o que não
  // existe, em vez de dizer os dois caminhos que ela tem.
  if (publicOff) return traduzir('vazio.acervoNaHome', { biblioteca: traduzir('cwd.library') });
  return traduzir('vazio.nenhumaFaixa');
}

/** Linha `fonte:` do painel de buffer do full player. */
export function bufferSourceLabel(args: {
  cached: boolean;
  downloading: number | null;
  hasStream: boolean;
  ahead: number;
}): string {
  if (args.cached) return traduzir('buffer.local');
  if (args.downloading != null) {
    return traduzir('buffer.baixando', { pct: Math.round(args.downloading * 100) });
  }
  return traduzir(args.hasStream ? 'buffer.stream' : 'buffer.previa', {
    tempo: fmtTime(args.ahead),
  });
}

/**
 * Linha `espaço` do painel de conta.
 *
 * O número que importa é quanto ainda CABE — é com ele que se decide se dá
 * para baixar o mix de uma hora. O total aparece junto só para dar escala.
 *
 * `quota` é opcional de propósito: nem todo navegador informa o limite, e
 * inventar um seria pior que dizer que não se sabe.
 */
export function storageLabel(uso: { bytes: number; quota?: number } | null): string {
  if (!uso) return traduzir('espaco.calculando');
  if (uso.quota == null) {
    return traduzir('espaco.semLimite', { usado: fmtBytes(uso.bytes) });
  }
  const livres = Math.max(0, uso.quota - uso.bytes);
  return traduzir('espaco.livres', { livres: fmtBytes(livres), total: fmtBytes(uso.quota) });
}

/** `buf:` da status line. */
export function bufferShortLabel(cached: boolean, ahead: number): string {
  return cached
    ? traduzir('buffer.curtoLocal')
    : traduzir('buffer.curtoAdiante', { tempo: fmtTime(ahead) });
}
