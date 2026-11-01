import type { Track } from '../types.js';

/** De onde a API do acervo responde. Mesma origem da PWA — sem CORS. */
const ROTA = '/api/acervo';

/**
 * Erro de acesso ao acervo, separado dos outros para quem chama poder decidir.
 *
 * `semSessao` é o caso normal e silencioso: visitante não tem acervo, e isso
 * não é falha nenhuma. Qualquer outro é problema de verdade e merece log.
 */
export class AcervoError extends Error {
  constructor(
    message: string,
    readonly semSessao = false,
  ) {
    super(message);
    this.name = 'AcervoError';
  }
}

/** Resposta da API: já vem no formato do `Track`, para não precisar de tradutor. */
interface Resposta {
  tracks?: unknown;
}

/**
 * Teto do tamanho da forma de onda aceita.
 *
 * A API manda 200 caracteres, mas isto aqui lê JSON que atravessou rede e
 * cache: sem teto, um campo absurdo viraria um array enorme a cada render da
 * barra. Folga de 4x em vez de exigir o número exato, para um dia aumentar a
 * resolução no servidor sem que a PWA velha pare de desenhar.
 */
const MAX_PICOS = 800;

function picosValidos(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_PICOS;
}

/**
 * Faixa válida o suficiente para entrar na lista.
 *
 * A API é nossa, mas a resposta é JSON que atravessa a rede e o cache do
 * navegador: uma faixa sem `id` ou sem `stream` viraria linha que não toca, e
 * o erro apareceria longe daqui.
 */
function valida(bruta: unknown): Track | null {
  if (!bruta || typeof bruta !== 'object') return null;
  const t = bruta as Record<string, unknown>;
  if (typeof t['id'] !== 'string' || !t['id']) return null;
  if (typeof t['stream'] !== 'string' || !t['stream']) return null;
  return {
    id: t['id'],
    title: typeof t['title'] === 'string' && t['title'] ? t['title'] : 'sem título',
    artist: typeof t['artist'] === 'string' && t['artist'] ? t['artist'] : 'acervo',
    genre: typeof t['genre'] === 'string' && t['genre'] ? t['genre'] : 'acervo',
    dur: typeof t['dur'] === 'number' && Number.isFinite(t['dur']) ? t['dur'] : 0,
    art: typeof t['art'] === 'string' ? t['art'] : '',
    ...(typeof t['artThumb'] === 'string' && t['artThumb'] ? { artThumb: t['artThumb'] } : {}),
    ...(picosValidos(t['peaks']) ? { peaks: t['peaks'] as string } : {}),
    // Só entra quando é string não vazia, e a ausência é significativa: é ela
    // que faz a faixa cair em `--acervo` em vez de `--compartilhadas`
    // (`visibleTracks`). Um `owner: ''` que passasse daqui poria a faixa
    // própria no recorte errado — daí a peneira ser `!!` e não `typeof`.
    ...(typeof t['owner'] === 'string' && t['owner'] ? { owner: t['owner'] } : {}),
    stream: t['stream'],
    // A API manda `premium: false` explícito; reforçamos aqui porque
    // `undefined` faria o heurístico do protótipo marcar música própria como
    // [pro] (ver access.ts).
    premium: false,
    source: 'acervo',
  };
}

/**
 * Lê as faixas próprias da API.
 *
 * Nada de URL assinada no catálogo: `stream` e `art` apontam para a nossa
 * própria API, que redireciona (302) para o R2 a cada pedido. É o que permite
 * guardar este catálogo em cache por 24h sem que a assinatura vença dentro
 * dele.
 */
export class AcervoCatalogClient {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    // Mesmo cuidado do AudiusCatalogClient: `fetch` precisa do global como
    // `this`, então não dá para guardar a referência solta.
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async tracks(signal?: AbortSignal): Promise<Track[]> {
    const res = await this.fetchImpl(ROTA, {
      // Mesma origem, então o cookie de sessão vai sozinho; explícito para não
      // depender do padrão de nenhum runtime.
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });

    if (res.status === 401) {
      throw new AcervoError('sem sessão', true);
    }
    if (res.status === 503) {
      // A API sobe sem credencial de R2 e responde 503 só aqui: é configuração
      // faltando no servidor, não erro de quem está usando.
      throw new AcervoError('acervo não configurado no servidor');
    }
    if (!res.ok) {
      throw new AcervoError(`acervo respondeu ${res.status}`);
    }

    const corpo = (await res.json()) as Resposta;
    if (!Array.isArray(corpo.tracks)) {
      throw new AcervoError('resposta do acervo sem lista de faixas');
    }
    return corpo.tracks.map(valida).filter((t): t is Track => t !== null);
  }
}
