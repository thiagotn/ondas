import { describe, expect, it } from 'vitest';
import { acharLink, rotuloDoLink } from '../link.js';

describe('acharLink', () => {
  it('reconhece um vídeo do YouTube nas formas em que ele é copiado', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?si=abc',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVM1',
      'https://m.youtube.com/shorts/dQw4w9WgXcQ',
    ]) {
      expect(acharLink(url), url).toMatchObject({ site: 'youtube', host: 'youtube.com', url });
    }
  });

  it('reconhece uma faixa do SoundCloud, e o encurtador', () => {
    expect(acharLink('https://soundcloud.com/artista/faixa?si=1')).toMatchObject({ site: 'soundcloud' });
    expect(acharLink('https://on.soundcloud.com/AbCdE')).toMatchObject({ site: 'soundcloud' });
  });

  it('reconhece URL direta de áudio pela extensão', () => {
    expect(acharLink('https://cdn.exemplo.test/pasta/musica.MP3?sig=x')).toMatchObject({
      site: 'midia',
      host: 'cdn.exemplo.test',
    });
  });

  it('acha o link no meio de uma frase, sem a pontuação do fim', () => {
    expect(acharLink('ouve isso: https://youtu.be/dQw4w9WgXcQ. é boa!')?.url).toBe(
      'https://youtu.be/dQw4w9WgXcQ',
    );
    expect(acharLink('(https://soundcloud.com/a/b)')?.url).toBe('https://soundcloud.com/a/b');
  });

  it('fica em silêncio para o que não é UMA faixa', () => {
    for (const texto of [
      '',
      null,
      'só um texto qualquer, sem link',
      'https://www.youtube.com/playlist?list=PLabcdefghijklmnop',
      'https://www.youtube.com/@canal',
      'https://www.youtube.com/results?search_query=x',
      'https://soundcloud.com/artista',
      'https://soundcloud.com/artista/sets/album',
      'https://soundcloud.com/artista/likes',
      'https://exemplo.test/uma-pagina',
      'https://exemplo.test/foto.jpg',
      'ftp://exemplo.test/a.mp3',
      // Host PARECIDO não é o site.
      'https://youtube.com.exemplo.test/watch?v=dQw4w9WgXcQ',
    ]) {
      expect(acharLink(texto), String(texto)).toBeNull();
    }
  });

  it('não sugere o link de uma faixa do próprio app', () => {
    const link = 'https://music.thiagotn.com/t/mare-baixa-D7KyD';
    expect(acharLink(link, 'music.thiagotn.com')).toBeNull();
    // Em outro host, `/t/…` não quer dizer nada — e sem extensão de áudio não é mídia.
    expect(acharLink(link, 'outro.exemplo.test')).toBeNull();
    // Um arquivo de áudio servido pelo mesmo host continua valendo.
    expect(acharLink('https://music.thiagotn.com/arquivos/a.mp3', 'music.thiagotn.com')).not.toBeNull();
  });
});

describe('rotuloDoLink', () => {
  it('mostra o site e o fim do caminho, nunca a query de uma URL assinada', () => {
    expect(rotuloDoLink(acharLink('https://youtu.be/dQw4w9WgXcQ?si=abc')!)).toBe('youtube.com/dQw4w9WgXcQ');
    expect(rotuloDoLink(acharLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ')!)).toBe(
      'youtube.com/dQw4w9WgXcQ',
    );
    expect(rotuloDoLink(acharLink('https://soundcloud.com/artista/faixa')!)).toBe('soundcloud.com/faixa');
    const rotulo = rotuloDoLink(acharLink('https://cdn.exemplo.test/a/musica.mp3?sig=SEGREDO')!);
    expect(rotulo).toBe('cdn.exemplo.test/musica.mp3');
    expect(rotulo).not.toContain('SEGREDO');
  });
});
