import type { Track } from '../types.js';

/** `/content/<cid>/<tamanho>.jpg` — o formato servido pelos nós do Audius. */
const CONTENT_PATH = /^\/content\/[^/]+\/[^/]+$/;
/** Quantas alternativas tentar antes de desistir e mostrar o placeholder. */
const MAX_FALLBACKS = 2;

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/**
 * Hosts que aparecem nas capas deste catálogo, do mais frequente para o menos.
 *
 * A capa de cada faixa é servida pelo nó que a guarda, não por um CDN — um
 * catálogo de 24 faixas costuma espalhar as imagens por ~18 hosts diferentes.
 * Quem aparece em mais faixas é o candidato mais provável de estar no ar.
 */
export function artworkHosts(tracks: readonly Track[]): string[] {
  const contagem = new Map<string, number>();
  for (const t of tracks) {
    for (const url of [t.art, t.artThumb]) {
      if (!url) continue;
      const host = hostOf(url);
      if (host) contagem.set(host, (contagem.get(host) ?? 0) + 1);
    }
  }
  return [...contagem.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([host]) => host);
}

/**
 * A mesma imagem em outros nós, para quando o original estiver fora do ar.
 *
 * O caminho carrega o CID do arquivo, então qualquer nó da rede devolve os
 * mesmos bytes — é o que permite se recuperar de um nó morto em vez de só
 * esconder o erro. URLs fora do padrão `/content/<cid>/…` (o catálogo demo, por
 * exemplo) não têm alternativa e voltam sozinhas.
 */
export function artworkSources(
  url: string | undefined,
  hosts: readonly string[],
  max = MAX_FALLBACKS,
): string[] {
  if (!url) return [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [url];
  }
  if (!CONTENT_PATH.test(parsed.pathname)) return [url];

  const alternativas = hosts
    .filter((h) => h !== parsed.host)
    .slice(0, Math.max(0, max))
    .map((h) => `${parsed.protocol}//${h}${parsed.pathname}${parsed.search}`);

  return [url, ...alternativas];
}
