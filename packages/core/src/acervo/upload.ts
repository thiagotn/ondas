import { AcervoError } from '../catalog/acervo.js';

const ROTA = '/api/acervo';

/** Quanto tempo esperar a ingestão terminar antes de desistir de acompanhar. */
const PRAZO_PADRAO_MS = 240_000;
/** Intervalo entre consultas ao status do job. */
const INTERVALO_MS = 2_000;

/**
 * O que o enviador precisa saber do arquivo.
 *
 * Interface própria em vez de `File`: `core` compila sem a lib DOM de
 * propósito (ver tsconfig), e o pouco que esta camada usa do arquivo é o nome
 * e o tamanho. Quem conhece `File` é a plataforma.
 */
export interface ArquivoEnviavel {
  readonly name: string;
  readonly size: number;
}

export type EstadoEnvio = 'preparando' | 'enviando' | 'processando' | 'pronto' | 'erro';

export interface ProgressoEnvio {
  estado: EstadoEnvio;
  /** Fração de 0 a 1 dos bytes já enviados ao bucket. */
  fracao: number;
  erro?: string;
  /** Preenchido quando o estado é `pronto`. */
  trackId?: string;
}

/**
 * Porta do envio dos bytes.
 *
 * Existe porque `fetch` **não reporta progresso de upload** — só de download.
 * Para a barra andar enquanto o arquivo sobe é preciso `XMLHttpRequest` (ou
 * streams, que o Safari não tem), e isso é detalhe de plataforma.
 */
export type EnviadorDeBytes<A> = (
  url: string,
  arquivo: A,
  aoProgredir: (bytesEnviados: number) => void,
  signal?: AbortSignal,
) => Promise<void>;

interface Vaga {
  id?: unknown;
  url?: unknown;
}

interface Job {
  id?: unknown;
  status?: unknown;
  error?: unknown;
  trackId?: unknown;
}

/**
 * Título de reserva a partir do nome do arquivo.
 *
 * Vai para `nome` no finalizar, e de lá para o título de RESERVA do job: as
 * tags do arquivo ganham dele. É só o que salva um arquivo sem tag nenhuma de
 * virar "sem título".
 */
export function tituloDoArquivo(nome: string): string {
  const semCaminho = nome.replace(/^.*[\\/]/, '');
  const semExtensao = semCaminho.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  return semExtensao.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface OpcoesDeEnvio {
  /** Título escolhido por quem enviou: ganha das tags do arquivo. */
  titulo?: string;
  artista?: string;
  aoMudar?: (p: ProgressoEnvio) => void;
  signal?: AbortSignal;
  prazoMs?: number;
}

/**
 * Envia um arquivo para o acervo, em três passos.
 *
 *  1. pede uma vaga à API, que devolve um PUT assinado;
 *  2. grava os bytes **direto no R2** com esse PUT;
 *  3. pede o finalizar, que enfileira a mesma ingestão da fase 2.
 *
 * Os bytes não passam pela API: o túnel tem teto de ~100MB por requisição e o
 * link do homelab é residencial — ir por dentro gastaria o upload do dono duas
 * vezes. O acompanhamento depois é o mesmo job de sempre.
 */
export class AcervoUploader<A extends ArquivoEnviavel> {
  private readonly fetchImpl: typeof fetch;
  private readonly enviarBytes: EnviadorDeBytes<A>;
  private readonly esperar: (ms: number) => Promise<void>;

  constructor(deps: {
    enviarBytes: EnviadorDeBytes<A>;
    fetchImpl?: typeof fetch;
    /** Injetável para o teste não esperar de verdade. */
    esperar?: (ms: number) => Promise<void>;
  }) {
    this.enviarBytes = deps.enviarBytes;
    // Mesmo cuidado dos outros clientes: `fetch` precisa do global como `this`.
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.esperar = deps.esperar ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Devolve o id da faixa criada. Lança `AcervoError` em qualquer falha. */
  async enviar(arquivo: A, opcoes: OpcoesDeEnvio = {}): Promise<string> {
    const avisar = (p: ProgressoEnvio) => opcoes.aoMudar?.(p);
    avisar({ estado: 'preparando', fracao: 0 });

    const vaga = await this.pedirVaga(arquivo, opcoes.signal);

    avisar({ estado: 'enviando', fracao: 0 });
    await this.enviarBytes(
      vaga.url,
      arquivo,
      (bytes) => {
        // Guarda contra divisão por zero e contra um relatório passando do
        // total (o XHR às vezes avisa o tamanho do corpo, não do arquivo).
        const fracao = arquivo.size > 0 ? Math.min(1, bytes / arquivo.size) : 0;
        avisar({ estado: 'enviando', fracao });
      },
      opcoes.signal,
    );

    avisar({ estado: 'processando', fracao: 1 });
    const jobID = await this.finalizar(vaga.id, arquivo, opcoes);
    const trackId = await this.acompanhar(jobID, opcoes);
    avisar({ estado: 'pronto', fracao: 1, trackId });
    return trackId;
  }

  private async pedirVaga(arquivo: A, signal?: AbortSignal): Promise<{ id: string; url: string }> {
    const res = await this.pedir(`${ROTA}/upload`, { bytes: arquivo.size }, signal);
    const corpo = (await this.corpo(res)) as Vaga;
    if (typeof corpo.id !== 'string' || !corpo.id || typeof corpo.url !== 'string' || !corpo.url) {
      throw new AcervoError('a API não devolveu a vaga do envio');
    }
    return { id: corpo.id, url: corpo.url };
  }

  private async finalizar(id: string, arquivo: A, opcoes: OpcoesDeEnvio): Promise<string> {
    const res = await this.pedir(
      `${ROTA}/upload/${encodeURIComponent(id)}/finalizar`,
      {
        title: opcoes.titulo ?? '',
        artist: opcoes.artista ?? '',
        nome: tituloDoArquivo(arquivo.name),
      },
      opcoes.signal,
    );
    const job = (await this.corpo(res)) as Job;
    if (typeof job.id !== 'string' || !job.id) {
      throw new AcervoError('a API aceitou o envio mas não devolveu o job');
    }
    return job.id;
  }

  /** Consulta o job até ele sair de pending/processing. */
  private async acompanhar(jobID: string, opcoes: OpcoesDeEnvio): Promise<string> {
    const prazo = opcoes.prazoMs ?? PRAZO_PADRAO_MS;
    const limite = Date.now() + prazo;
    for (;;) {
      const res = await this.fetchImpl(`${ROTA}/ingest/${encodeURIComponent(jobID)}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        ...(opcoes.signal ? { signal: opcoes.signal } : {}),
      });
      const job = (await this.corpo(res)) as Job;

      if (job.status === 'ready') {
        if (typeof job.trackId !== 'string' || !job.trackId) {
          throw new AcervoError('a ingestão terminou sem id de faixa');
        }
        return job.trackId;
      }
      if (job.status === 'error') {
        throw new AcervoError(
          typeof job.error === 'string' && job.error ? job.error : 'a ingestão falhou',
        );
      }
      if (Date.now() + INTERVALO_MS >= limite) {
        // Não é falha definitiva: o worker continua: a faixa deve aparecer
        // sozinha no catálogo depois. A tela precisa poder dizer isso.
        throw new AcervoError('o arquivo subiu, mas o processamento está demorando');
      }
      await this.esperar(INTERVALO_MS);
    }
  }

  private pedir(rota: string, corpo: unknown, signal?: AbortSignal): Promise<Response> {
    return this.fetchImpl(rota, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(corpo),
      ...(signal ? { signal } : {}),
    });
  }

  /** Converte status de erro em `AcervoError` com a mensagem da API. */
  private async corpo(res: Response): Promise<unknown> {
    const texto = await res.text();
    let json: unknown;
    try {
      json = texto ? JSON.parse(texto) : {};
    } catch {
      json = {};
    }
    if (res.ok) return json;

    const msg =
      typeof json === 'object' && json && typeof (json as { error?: unknown }).error === 'string'
        ? (json as { error: string }).error
        : `a API respondeu ${res.status}`;
    // 401 aqui é sessão que caiu no meio do envio: a tela manda para o login
    // em vez de mostrar erro técnico.
    throw new AcervoError(msg, res.status === 401);
  }
}
