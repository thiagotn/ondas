/**
 * Link de faixa — o que se manda para alguém.
 *
 *     público:  /t/turbo-vicio-concreto-molhado-J72oWO6
 *     acervo:   /t/_11111111111141118111111111111111
 *
 * Uma regra só governa a leitura: **o token é o que vem depois do último
 * hífen, e o token nunca contém hífen**. O texto antes dele é decoração —
 * mudar o título de uma faixa não quebra link antigo.
 */

import type { Track } from './types.js';

export const TRACK_PATH_PREFIX = '/t/';

/** Prefixo do id das faixas próprias, como a API do acervo o emite. */
const PREFIXO_ACERVO = 'acervo:';

/**
 * Sigilo do token de faixa privada.
 *
 * `_` é `unreserved` na RFC 3986 (não precisa de percent-encoding) e **não
 * existe** no alfabeto de id do Audius, então ele distingue as duas fontes sem
 * ambiguidade.
 */
const SIGILO_ACERVO = '_';

/** Id do Audius: hashid alfanumérico. Conferido no trending: 6–7 chars, nunca com hífen. */
const ID_PUBLICO = /^[A-Za-z0-9]{3,32}$/;

/** Uuid do acervo sem os hífens. */
const ID_PRIVADO = /^[0-9a-f]{32}$/i;

/** Teto do segmento, para um caminho absurdo não virar trabalho de parse. */
const MAX_SEGMENTO = 120;

/** Teto do slug. Longo o bastante para ser legível, curto para caber num chat. */
const MAX_SLUG = 60;

/**
 * Texto → pedaço de URL legível.
 *
 * Não reusa `slugGenre` de `format.ts`: aquele **remove** os separadores
 * (`lo-fi` vira `lofi`), que é o certo para casar nome de gênero e errado
 * aqui, onde o hífen é o que torna a URL legível. São duas funções de
 * propósito — unificar as duas quebraria um dos dois usos.
 */
export function slugify(texto: string, max = MAX_SLUG): string {
  const bruto = String(texto ?? '')
    .normalize('NFD')
    // Remove os diacríticos que o NFD separou das letras.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!bruto) return 'faixa';
  if (bruto.length <= max) return bruto;
  // Corta numa fronteira de hífen: um slug terminado em `-` ou com uma palavra
  // pela metade fica feio, e `-` no fim confundiria o parser.
  const cortado = bruto.slice(0, max);
  const ultimo = cortado.lastIndexOf('-');
  return (ultimo > 0 ? cortado.slice(0, ultimo) : cortado).replace(/-+$/, '');
}

type FaixaCompartilhavel = Pick<Track, 'id' | 'title' | 'artist'> & Partial<Pick<Track, 'source'>>;

function ehDoAcervo(track: FaixaCompartilhavel): boolean {
  return track.source === 'acervo' || track.id.startsWith(PREFIXO_ACERVO);
}

/**
 * Caminho do link da faixa.
 *
 * Faixa do acervo sai **sem slug**: o slug vem de título e artista, e a URL de
 * uma faixa privada não pode contar o que ela é para quem só recebeu o link.
 */
export function trackPath(track: FaixaCompartilhavel): string {
  if (ehDoAcervo(track)) {
    const uuid = track.id.slice(PREFIXO_ACERVO.length).replace(/-/g, '').toLowerCase();
    return TRACK_PATH_PREFIX + SIGILO_ACERVO + uuid;
  }
  return TRACK_PATH_PREFIX + slugify(`${track.artist} ${track.title}`) + '-' + track.id;
}

/** O link inteiro, para copiar ou mandar pelo `navigator.share`. */
export function trackUrl(track: FaixaCompartilhavel, origin: string): string {
  return origin.replace(/\/+$/, '') + trackPath(track);
}

/**
 * Token da URL → id de faixa, ou `null` quando não é link de faixa.
 *
 * Esta é a única leitura do formato; `parseTrackPath` só recorta e chama aqui.
 */
export function parseTrackToken(segmento: string | null | undefined): string | null {
  const seg = String(segmento ?? '');
  if (!seg || seg.length > MAX_SEGMENTO) return null;

  if (seg.startsWith(SIGILO_ACERVO)) {
    const hex = seg.slice(1).toLowerCase();
    if (!ID_PRIVADO.test(hex)) return null;
    const uuid = [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join('-');
    // Tem de sair idêntico ao id que a API emite: o casamento com `Track.id`
    // é comparação de string, não de uuid.
    return PREFIXO_ACERVO + uuid;
  }

  // Sem hífen o segmento inteiro é o id — link digitado à mão, sem decoração.
  const corte = seg.lastIndexOf('-');
  const token = corte < 0 ? seg : seg.slice(corte + 1);
  return ID_PUBLICO.test(token) ? token : null;
}

/**
 * `location.pathname` → id de faixa, ou `null`.
 *
 * Recebe só o caminho: query e hash não entram na identidade da faixa.
 */
export function parseTrackPath(pathname: string | null | undefined): string | null {
  const caminho = String(pathname ?? '');
  if (!caminho.startsWith(TRACK_PATH_PREFIX)) return null;
  // Barra final é tolerada (unfurler às vezes acrescenta); um segundo segmento
  // não é link de faixa.
  const resto = caminho.slice(TRACK_PATH_PREFIX.length).replace(/\/+$/, '');
  if (!resto || resto.includes('/')) return null;
  return parseTrackToken(resto);
}
