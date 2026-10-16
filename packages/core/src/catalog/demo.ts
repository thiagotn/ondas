import type { Track } from '../types.js';
import type { CatalogClient } from './client.js';

const DEMO: readonly (readonly [string, string, string, number])[] = [
  ['Maré Baixa', 'Lia Sombra', 'ambient', 214],
  ['Concreto Molhado', 'Turbo Vício', 'techno', 356],
  ['Neon na Chuva', 'Kaio Ruas', 'synthwave', 241],
  ['Fio de Cobre', 'Bruma', 'lofi', 172],
  ['Último Trem', 'Vera Noir', 'house', 298],
  ['Sal & Ferrugem', 'Os Alfaiates', 'indie', 203],
  ['Céu de Sódio', 'Lia Sombra', 'ambient', 265],
  ['Pressão 808', 'MC Lunar', 'hiphop', 187],
  ['Calçada Fria', 'Bruma', 'lofi', 149],
  ['Ponto Cego', 'Turbo Vício', 'techno', 412],
  ['Dobra', 'Kaio Ruas', 'electronic', 230],
  ['Fim de Turno', 'Vera Noir', 'house', 322],
];

/**
 * Catálogo de reserva: 12 faixas sem áudio. Sem `stream`, o player cai no
 * playback simulado, então a UI continua demonstrável sem rede nem API.
 */
export class DemoCatalogClient implements CatalogClient {
  async trending(): Promise<Track[]> {
    return demoTracks();
  }
}

export function demoTracks(): Track[] {
  return DEMO.map(([title, artist, genre, dur], i) => ({
    id: 'demo' + i,
    title,
    artist,
    genre,
    dur,
    art: '',
    stream: '',
  }));
}
