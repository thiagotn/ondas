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
