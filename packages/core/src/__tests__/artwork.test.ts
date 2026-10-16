import { describe, expect, it } from 'vitest';
import { artworkHosts, artworkSources } from '../catalog/artwork.js';
import type { Track } from '../types.js';

const faixa = (id: string, art: string, artThumb?: string): Track => ({
  id,
  title: id,
  artist: 'x',
  genre: 'techno',
  dur: 100,
  art,
  ...(artThumb ? { artThumb } : {}),
  stream: '',
});

const CID = '/content/baeaaaiqsedqymsf/480x480.jpg';

describe('artworkHosts', () => {
  it('ordena do host mais frequente para o menos', () => {
    const hosts = artworkHosts([
      faixa('1', 'https://a.net' + CID),
      faixa('2', 'https://b.net' + CID),
      faixa('3', 'https://b.net' + CID),
      faixa('4', 'https://c.net' + CID),
      faixa('5', 'https://c.net' + CID),
      faixa('6', 'https://c.net' + CID),
    ]);
    expect(hosts).toEqual(['c.net', 'b.net', 'a.net']);
  });

  it('ignora faixas sem capa e URLs inválidas', () => {
    expect(artworkHosts([faixa('1', ''), faixa('2', 'nao-e-url')])).toEqual([]);
  });
});

describe('artworkSources', () => {
  const hosts = ['a.net', 'b.net', 'c.net', 'd.net'];

  it('oferece a mesma imagem em outros nós, sem repetir o de origem', () => {
    expect(artworkSources('https://b.net' + CID, hosts)).toEqual([
      'https://b.net' + CID,
      'https://a.net' + CID,
      'https://c.net' + CID,
    ]);
  });

  it('respeita o teto de alternativas', () => {
    expect(artworkSources('https://b.net' + CID, hosts, 1)).toHaveLength(2);
    expect(artworkSources('https://b.net' + CID, hosts, 0)).toHaveLength(1);
  });

  it('não inventa alternativa para URL fora do padrão de conteúdo', () => {
    const outra = 'https://exemplo.com/capa.jpg';
    expect(artworkSources(outra, hosts)).toEqual([outra]);
  });

  it('devolve vazio quando não há capa', () => {
    expect(artworkSources(undefined, hosts)).toEqual([]);
    expect(artworkSources('', hosts)).toEqual([]);
  });
});
