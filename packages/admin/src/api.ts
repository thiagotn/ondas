/**
 * O cliente das rotas de `/api/admin`.
 *
 * Mora neste pacote, e não no `@ondas/core`, de propósito: o core vai para o
 * bundle da PWA, e nada de administração deve chegar a quem só veio ouvir
 * música.
 *
 * A credencial é o cookie `ondas_admin` (`HttpOnly`, só para `/api/admin`),
 * que o servidor entrega em troca do token. Este código nunca guarda o token:
 * ele passa pela memória do formulário de entrada e some.
 */

export interface Conta {
  id: string;
  email: string;
  name: string;
  status: 'pendente' | 'aprovada' | 'negada';
  podeEnviar: boolean;
  mensagem?: string;
  criadaEm: string;
  decididoEm?: string;
  recebeDoBot: boolean;
  planoId: string;
  planoNome: string;
  cotaExtraBytes: number;
  cotaBytes: number;
  faixas: number;
  usadoBytes: number;
  ultimoLoginEm?: string;
  ultimaEscutaEm?: string;
}

export interface Faixa {
  id: string;
  titulo: string;
  artista: string;
  duracaoS: number;
  tipo: string;
  audioBytes: number;
  capaBytes: number;
  visibilidade: 'privada' | 'todos';
  criadaEm: string;
  donoId: string;
  donoEmail: string;
  donoNome: string;
}

export interface Ingestao {
  id: string;
  status: 'pending' | 'processing' | 'ready' | 'error';
  tentativas: number;
  erro?: string;
  fonte: string;
  titulo?: string;
  faixaId?: string;
  pedidoPor: string;
  destino?: string;
  /** `pagina` enquanto o node ainda não baixou o link; `midia` depois. */
  tipo: 'midia' | 'pagina';
  criadaEm: string;
  atualizadaEm: string;
}

export interface Resumo {
  contas: Record<string, number>;
  faixas: number;
  audioBytes: number;
  capaBytes: number;
  ingestoes: Record<string, number>;
  convites: number;
  cadastroAberto: boolean;
  acimaDaCota: number;
}

/** As chaves globais que o admin liga e desliga. */
export interface Config {
  cadastroAberto: boolean;
  /** Passar da cota recusa faixa nova? Desligada, a cota só é medida. */
  cotaBloqueia: boolean;
}

export interface Convite {
  email: string;
  podeEnviar: boolean;
  recebeDoBot: boolean;
  nota?: string;
  criadoEm: string;
}

export interface Plano {
  id: string;
  nome: string;
  cotaBytes: number;
  contas: number;
  criadoEm: string;
}

export interface Evento {
  id: number;
  em: string;
  acao: string;
  alvoTipo?: string;
  alvoId?: string;
  alvoRotulo?: string;
  detalhe?: string;
  ip?: string;
}

export interface Ajuste {
  podeEnviar?: boolean;
  recebeDoBot?: boolean;
  planoId?: string;
  cotaExtraBytes?: number;
}

export class ErroDaApi extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly codigo?: string,
  ) {
    super(message);
    this.name = 'ErroDaApi';
  }
}

/** Avisado quando o servidor diz 401: a sessão do painel acabou. */
let aoPerderSessao: () => void = () => {};
export function ouvirSessaoPerdida(fn: () => void): void {
  aoPerderSessao = fn;
}

const RAIZ = '/api/admin';

async function pedir<T>(metodo: string, caminho: string, corpo?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(RAIZ + caminho, {
      method: metodo,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(corpo === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    });
  } catch {
    throw new ErroDaApi('sem resposta do servidor', 0);
  }
  if (res.ok) return (await res.json()) as T;

  let msg = `o servidor respondeu ${res.status}`;
  let codigo: string | undefined;
  try {
    const erro = (await res.json()) as { error?: unknown; code?: unknown };
    if (typeof erro.error === 'string' && erro.error) msg = erro.error;
    if (typeof erro.code === 'string') codigo = erro.code;
  } catch {
    // Resposta sem JSON (um 502 do proxy, por exemplo): fica a frase genérica.
  }
  // A entrada tem o próprio tratamento do 401 ("token inválido"); em qualquer
  // outra rota ele quer dizer que a sessão venceu.
  if (res.status === 401 && caminho !== '/sessao') aoPerderSessao();
  throw new ErroDaApi(msg, res.status, codigo);
}

const q = (params: Record<string, string | number | undefined>): string => {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
};

export const api = {
  entrar: (token: string) => pedir<{ status: string }>('POST', '/sessao', { token }),
  sair: () => pedir<{ status: string }>('DELETE', '/sessao'),
  sessao: () => pedir<{ status: string }>('GET', '/sessao'),

  resumo: () => pedir<Resumo>('GET', '/resumo'),

  contas: (status?: string) =>
    pedir<{ contas: Conta[] }>('GET', '/contas' + q({ status })).then((r) => r.contas),
  conta: (id: string) =>
    pedir<{ conta: Conta; faixas: Faixa[]; ingestoes: Ingestao[] }>('GET', `/contas/${id}`),
  aprovar: (id: string) => pedir<unknown>('POST', `/contas/${id}/aprovar`),
  negar: (id: string) => pedir<unknown>('POST', `/contas/${id}/negar`),
  ajustar: (id: string, ajuste: Ajuste) => pedir<Conta>('PATCH', `/contas/${id}`, ajuste),
  apagarConta: (id: string) => pedir<unknown>('DELETE', `/contas/${id}`),

  faixas: (ordem: 'tamanho' | 'recentes') =>
    pedir<{ faixas: Faixa[] }>('GET', '/faixas' + q({ ordem })).then((r) => r.faixas),
  apagarFaixa: (id: string) => pedir<unknown>('DELETE', `/faixas/${id}`),

  ingestoes: (status?: string) =>
    pedir<{ ingestoes: Ingestao[] }>('GET', '/ingestoes' + q({ status })).then((r) => r.ingestoes),

  config: () => pedir<Config>('GET', '/config'),
  definirCadastro: (cadastroAberto: boolean) => pedir<Config>('PUT', '/config', { cadastroAberto }),
  definirCotaBloqueia: (cotaBloqueia: boolean) => pedir<Config>('PUT', '/config', { cotaBloqueia }),
  convites: () => pedir<{ convites: Convite[] }>('GET', '/convites').then((r) => r.convites),
  convidar: (c: { email: string; podeEnviar: boolean; recebeDoBot: boolean; nota: string }) =>
    pedir<Convite>('POST', '/convites', c),
  removerConvite: (email: string) => pedir<unknown>('DELETE', '/convites' + q({ email })),

  planos: () => pedir<{ planos: Plano[] }>('GET', '/planos').then((r) => r.planos),
  criarPlano: (p: { id: string; nome: string; cotaBytes: number }) => pedir<Plano>('POST', '/planos', p),
  atualizarPlano: (id: string, p: { nome?: string; cotaBytes?: number }) =>
    pedir<Plano>('PATCH', `/planos/${id}`, p),

  eventos: () => pedir<{ eventos: Evento[] }>('GET', '/eventos').then((r) => r.eventos),
};
