import { fmtBytes } from '@ondas/core';

export { fmtBytes };

const DATA = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const SO_DATA = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });

export function fmtQuando(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : DATA.format(d);
}

export function fmtDia(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : SO_DATA.format(d);
}

/** "há 3 dias" — para a coluna de atividade, onde a data exata importa menos. */
export function fmtHa(iso: string | undefined, agora = Date.now()): string {
  if (!iso) return 'nunca';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'nunca';
  const min = Math.max(0, Math.round((agora - t) / 60_000));
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  if (d < 60) return `há ${d} d`;
  return `há ${Math.round(d / 30)} meses`;
}

export function fmtDuracao(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

const UNIDADES: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
};

/**
 * Lê um tamanho digitado: `500 MB`, `1,5 gb`, `2GB`, `0`. Sem unidade vale MB,
 * que é a ordem de grandeza de uma faixa. `null` quando não dá para entender —
 * quem chama recusa, em vez de gravar um número que ninguém digitou.
 */
export function lerTamanho(texto: string): number | null {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*([a-zA-Z]{0,2})\s*$/.exec(texto);
  if (!m) return null;
  const unidade = UNIDADES[(m[2] || 'mb').toLowerCase()];
  if (!unidade) return null;
  const n = Number(m[1]!.replace(',', '.')) * unidade;
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** O inverso de `lerTamanho`, para preencher o campo com o valor atual. */
export function escreverTamanho(bytes: number): string {
  if (bytes === 0) return '0';
  for (const [nome, fator] of [
    ['GB', 1024 ** 3],
    ['MB', 1024 ** 2],
    ['KB', 1024],
  ] as const) {
    if (bytes >= fator) {
      const v = bytes / fator;
      return `${Number.isInteger(v) ? v : v.toFixed(2).replace('.', ',')} ${nome}`;
    }
  }
  return `${bytes} B`;
}

const ROTULO_STATUS: Record<string, string> = {
  pendente: 'em análise',
  aprovada: 'aprovada',
  negada: 'negada',
  pending: 'na fila',
  processing: 'processando',
  ready: 'pronta',
  error: 'erro',
};

export const rotuloStatus = (s: string): string => ROTULO_STATUS[s] ?? s;

const ROTULO_ACAO: Record<string, string> = {
  'sessao.aberta': 'entrou no painel',
  'conta.aprovada': 'aprovou a conta',
  'conta.negada': 'negou a conta',
  'conta.pendente': 'devolveu a conta para análise',
  'conta.ajustada': 'ajustou a conta',
  'conta.apagada': 'apagou a conta',
  'faixa.apagada': 'apagou a faixa',
  'cadastro.aberto': 'abriu o cadastro',
  'cadastro.fechado': 'fechou o cadastro',
  'cota.bloqueia': 'ligou o bloqueio por cota',
  'cota.so_mede': 'desligou o bloqueio por cota',
  'convite.criado': 'convidou',
  'convite.removido': 'removeu o convite de',
  'plano.criado': 'criou o plano',
  'plano.alterado': 'alterou o plano',
};

export const rotuloAcao = (a: string): string => ROTULO_ACAO[a] ?? a;
