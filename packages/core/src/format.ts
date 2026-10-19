/** Formatação e hashing — compartilhado entre web e nativo. */

/** FNV-1a. Mesmo hash do protótipo: semeia waveform e cor de gênero. */
export function hash(str: string): number {
  let h = 2166136261;
  for (const c of String(str)) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Segundos → `m:ss`. Negativos e NaN viram `0:00`. */
export function fmtTime(s: number): string {
  const v = Math.max(0, Math.floor(s || 0));
  return Math.floor(v / 60) + ':' + String(v % 60).padStart(2, '0');
}

/** Bytes → `X.X MB`. */
export function fmtMB(bytes: number): string {
  return (bytes / 1048576).toFixed(1) + ' MB';
}

/**
 * Bytes → `X.X MB` ou `X.X GB`.
 *
 * Existe separado do `fmtMB` porque a cota do navegador é da ordem de giga, e
 * "4005.4 MB" não é número que alguém leia. O `fmtMB` continua para o que é
 * sempre pequeno (o tamanho de uma faixa).
 */
export function fmtBytes(bytes: number): string {
  const gb = bytes / 1073741824;
  return gb >= 1 ? gb.toFixed(1) + ' GB' : fmtMB(bytes);
}

/** Gênero → slug minúsculo sem acento nem separador. */
export function slugGenre(g: string | null | undefined): string {
  return String(g || 'outros')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z0-9]/g, '');
}

/** Cor do `#genero`: ansi-1..ansi-6 derivado do hash. */
export function genreAnsiVar(genre: string): string {
  return 'var(--ansi-' + (1 + (hash(genre) % 6)) + ')';
}

/** Progresso de download como no protótipo: ` 42%` em 4ch (` 7%` → `  7%`). */
export function dlPct(progress: number): string {
  return String(Math.round(progress * 100)).padStart(3, ' ') + '%';
}

/**
 * Barra de progresso em caracteres, no estilo do terminal: `[####······]`.
 *
 * Pura e aqui dentro porque é a única parte do envio que precisa ficar
 * estável: a largura é em colunas, então um arredondamento errado faz a barra
 * mudar de tamanho no meio do upload e o layout tremer.
 */
export function barraDeProgresso(fracao: number, largura = 12): string {
  const colunas = Math.max(1, Math.floor(largura));
  const limpa = Number.isFinite(fracao) ? Math.min(1, Math.max(0, fracao)) : 0;
  const cheias = Math.round(limpa * colunas);
  return '[' + '#'.repeat(cheias) + '·'.repeat(colunas - cheias) + ']';
}
