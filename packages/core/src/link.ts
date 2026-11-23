import { parseTrackPath } from './share.js';

/** De onde é o link, para a tela dizer "link do YouTube" em vez de só "link". */
export type SiteDoLink = 'youtube' | 'soundcloud' | 'midia';

export interface LinkAchado {
  /** A URL como estava no texto, sem a pontuação que veio grudada no fim. */
  url: string;
  site: SiteDoLink;
  /** `youtube.com`, `soundcloud.com` ou o host do arquivo — é o que a tela mostra. */
  host: string;
}

const HOSTS_YOUTUBE = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);
const CAMINHOS_DE_VIDEO = new Set(['shorts', 'live', 'embed', 'v']);
const HOSTS_SOUNDCLOUD = new Set(['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com']);
const HOST_CURTO_SOUNDCLOUD = 'on.soundcloud.com';
const RESERVADOS_SOUNDCLOUD = new Set([
  'likes',
  'sets',
  'reposts',
  'tracks',
  'albums',
  'comments',
  'following',
  'followers',
  'popular-tracks',
  'toptracks',
  'stats',
  'insights',
  'groups',
]);
const ID_DE_VIDEO = /^[A-Za-z0-9_-]{11}$/;
/** As extensões que o acervo toca — as do `accept` do painel de envio. */
const EXTENSAO_DE_AUDIO = /\.(mp3|m4a|aac|flac|opus|ogg|wav)$/i;

/** A primeira URL http(s) de um texto. Espaço, aspas e `<>` encerram. */
const PRIMEIRA_URL = /https?:\/\/[^\s<>"'`]+/i;

/**
 * Acha, num texto qualquer, um link de música que o acervo sabe trazer.
 *
 * É só para decidir se o app SUGERE — quem decide de verdade o que o link é, e
 * se pode entrar, é o servidor (`ingest.ClassificarLink`, na API), com as
 * mesmas regras. Errar aqui para o lado do silêncio é o certo: um aviso que
 * aparece para link que não serve ensina a pessoa a ignorar o aviso.
 *
 * Por isso só casa o que é reconhecidamente UMA faixa: um vídeo do YouTube,
 * uma faixa do SoundCloud, ou uma URL que termina em extensão de áudio.
 * Playlist, canal, perfil e qualquer outro site voltam `null`.
 *
 * `hostProprio` é o host do próprio app: o link de uma faixa do Ondas no
 * clipboard (acabou de ser compartilhado daqui) não é sugestão de ingestão.
 *
 * O texto do clipboard é dado privado. Esta função só olha — nada do que ela
 * recebe sai do aparelho, e o que ela devolve é a URL e mais nada.
 */
export function acharLink(texto: string | null | undefined, hostProprio = ''): LinkAchado | null {
  const achado = PRIMEIRA_URL.exec(String(texto ?? '').slice(0, 4096));
  if (!achado) return null;
  // Pontuação que a frase em volta deixou colada: "ouve isso: https://…/x."
  const bruta = achado[0].replace(/[).,;:!?\]]+$/, '');

  let u: URL;
  try {
    u = new URL(bruta);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const partes = u.pathname.split('/').filter(Boolean);

  // Link de faixa do próprio app (`/t/…`): acabou de ser compartilhado daqui.
  if (hostProprio && host === hostProprio.toLowerCase().replace(/:\d+$/, '') && parseTrackPath(u.pathname)) {
    return null;
  }

  if (HOSTS_YOUTUBE.has(host)) {
    const primeiro = (partes[0] ?? '').toLowerCase();
    let vid = '';
    if (host === 'youtu.be' || host === 'www.youtu.be') vid = partes[0] ?? '';
    else if (CAMINHOS_DE_VIDEO.has(primeiro)) vid = partes[1] ?? '';
    else if (primeiro === 'watch') vid = u.searchParams.get('v') ?? '';
    return ID_DE_VIDEO.test(vid) ? { url: bruta, site: 'youtube', host: 'youtube.com' } : null;
  }

  if (HOSTS_SOUNDCLOUD.has(host)) {
    if (partes.length !== 2 || RESERVADOS_SOUNDCLOUD.has((partes[1] ?? '').toLowerCase())) return null;
    return { url: bruta, site: 'soundcloud', host: 'soundcloud.com' };
  }
  if (host === HOST_CURTO_SOUNDCLOUD) {
    return partes.length === 1 ? { url: bruta, site: 'soundcloud', host: 'soundcloud.com' } : null;
  }

  return EXTENSAO_DE_AUDIO.test(u.pathname) ? { url: bruta, site: 'midia', host } : null;
}

/**
 * Um rótulo curto para a fila de envio: o site e o fim do caminho. A URL
 * inteira não cabe na linha, e a de mídia pode trazer assinatura na query —
 * que não é para ficar exposta na tela.
 */
export function rotuloDoLink(link: LinkAchado): string {
  let caminho = '';
  try {
    const u = new URL(link.url);
    const partes = u.pathname.split('/').filter(Boolean);
    caminho = link.site === 'youtube' ? (u.searchParams.get('v') ?? partes.at(-1) ?? '') : (partes.at(-1) ?? '');
  } catch {
    // Não chega aqui com um `LinkAchado` de verdade; sem caminho, fica o host.
  }
  return caminho ? `${link.host}/${caminho}` : link.host;
}
