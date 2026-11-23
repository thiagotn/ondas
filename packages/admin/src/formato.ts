import { fmtBytes, idioma } from '@ondas/core';
import { t, tSe } from './i18n';

export { fmtBytes };

/**
 * Os formatadores de data seguem o idioma do painel, e por isso nascem na
 * primeira chamada: no topo do módulo o idioma ainda não foi decidido.
 */
let formatos: { locale: string; data: Intl.DateTimeFormat; dia: Intl.DateTimeFormat } | null = null;
function fmt() {
  if (formatos?.locale !== idioma()) {
    formatos = {
      locale: idioma(),
      data: new Intl.DateTimeFormat(idioma(), { dateStyle: 'short', timeStyle: 'short' }),
      dia: new Intl.DateTimeFormat(idioma(), { dateStyle: 'short' }),
    };
  }
  return formatos;
}

export function fmtQuando(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : fmt().data.format(d);
}

export function fmtDia(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : fmt().dia.format(d);
}

/** "há 3 dias" — para a coluna de atividade, onde a data exata importa menos. */
export function fmtHa(iso: string | undefined, agora = Date.now()): string {
  if (!iso) return t('quando.nunca');
  const quando = new Date(iso).getTime();
  if (Number.isNaN(quando)) return t('quando.nunca');
  const min = Math.max(0, Math.round((agora - quando) / 60_000));
  if (min < 1) return t('quando.agora');
  if (min < 60) return t('quando.min', { n: min });
  const h = Math.round(min / 60);
  if (h < 24) return t('quando.h', { n: h });
  const d = Math.round(h / 24);
  if (d < 60) return t('quando.d', { n: d });
  return t('quando.meses', { n: Math.round(d / 30) });
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
      // O decimal do idioma — e `lerTamanho` entende os dois, então o que este
      // campo mostra sempre pode ser salvo de volta.
      const decimal = idioma() === 'en' ? '.' : ',';
      return `${Number.isInteger(v) ? v : v.toFixed(2).replace('.', decimal)} ${nome}`;
    }
  }
  return `${bytes} B`;
}

/** Status de conta ou de job → a palavra da tela. Valor desconhecido sai cru. */
export const rotuloStatus = (s: string): string => tSe('status.' + s) ?? s;

/** Ação do histórico → a frase. Ação que esta tela não conhece sai crua. */
export const rotuloAcao = (a: string): string => tSe('acao.' + a) ?? a;
