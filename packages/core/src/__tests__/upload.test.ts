import { describe, expect, it, vi } from 'vitest';
import { AcervoUploader, tituloDoArquivo, type ProgressoEnvio } from '../acervo/upload.js';
import { AcervoError } from '../catalog/acervo.js';

/** Resposta de mentira: o uploader lê `text()`, não `json()`. */
const resposta = (status: number, corpo: unknown = {}): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(corpo),
  }) as Response;

const arquivo = { name: '01 - Faixa_Boa.mp3', size: 4096 };

/**
 * Roteiro de respostas por rota, na ordem em que o uploader as pede. O
 * `ingest` aceita uma fila, para simular pending → ready.
 */
function fetchFalso(roteiro: {
  upload?: Response;
  finalizar?: Response;
  ingest?: Response[];
}) {
  const chamadas: { url: string; corpo?: unknown }[] = [];
  const ingest = [...(roteiro.ingest ?? [])];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    chamadas.push({
      url,
      ...(init?.body ? { corpo: JSON.parse(String(init.body)) } : {}),
    });
    if (url.endsWith('/upload')) {
      return roteiro.upload ?? resposta(200, { id: 'env-1', url: 'https://r2.test/assinada' });
    }
    if (url.includes('/finalizar')) {
      return roteiro.finalizar ?? resposta(202, { id: 'job-1', status: 'pending' });
    }
    if (ingest.length > 1) return ingest.shift() as Response;
    return ingest[0] ?? resposta(200, { id: 'job-1', status: 'ready', trackId: 'acervo:9' });
  });
  return { impl: impl as unknown as typeof fetch, chamadas };
}

const semEspera = () => Promise.resolve();

describe('tituloDoArquivo', () => {
  it('tira extensão, caminho e enfeites do nome', () => {
    expect(tituloDoArquivo('Noite Fria.mp3')).toBe('Noite Fria');
    expect(tituloDoArquivo('pasta/sub/Noite_Fria.flac')).toBe('Noite Fria');
    expect(tituloDoArquivo('C:\\Musica\\Noite  Fria.opus')).toBe('Noite Fria');
    expect(tituloDoArquivo('sem-extensao')).toBe('sem-extensao');
    // Ponto no meio do nome não é extensão.
    expect(tituloDoArquivo('Vol. 2 - Faixa.mp3')).toBe('Vol. 2 - Faixa');
  });
});

describe('AcervoUploader', () => {
  it('pede vaga, grava no bucket, finaliza e devolve a faixa', async () => {
    const { impl, chamadas } = fetchFalso({});
    const enviados: string[] = [];
    const enviarBytes = vi.fn(async (url: string, _a: unknown, aoProgredir: (n: number) => void) => {
      enviados.push(url);
      aoProgredir(2048);
      aoProgredir(4096);
    });
    const progresso: ProgressoEnvio[] = [];

    const trackId = await new AcervoUploader({
      enviarBytes,
      fetchImpl: impl,
      esperar: semEspera,
    }).enviar(arquivo, { aoMudar: (p) => progresso.push(p) });

    expect(trackId).toBe('acervo:9');
    // Os bytes foram para a URL assinada do R2, não para a nossa API.
    expect(enviados).toEqual(['https://r2.test/assinada']);
    expect(chamadas.map((c) => c.url)).toEqual([
      '/api/acervo/upload',
      '/api/acervo/upload/env-1/finalizar',
      '/api/acervo/ingest/job-1',
    ]);
    // O tamanho declarado é o do arquivo: é o que deixa a API recusar antes
    // de o usuário gastar o upload.
    expect(chamadas[0]?.corpo).toEqual({ bytes: 4096 });

    const estados = progresso.map((p) => p.estado);
    expect(estados[0]).toBe('preparando');
    expect(estados).toContain('enviando');
    expect(estados).toContain('processando');
    expect(estados.at(-1)).toBe('pronto');
    expect(progresso.at(-1)?.trackId).toBe('acervo:9');
  });

  // A decisão de precedência vista do cliente: o nome do arquivo vai em
  // `nome` (reserva), nunca em `title` — senão ganharia das tags do MP3.
  it('manda o nome do arquivo como reserva e deixa o título vazio', async () => {
    const { impl, chamadas } = fetchFalso({});
    await new AcervoUploader({ enviarBytes: async () => {}, fetchImpl: impl, esperar: semEspera }).enviar(
      arquivo,
    );

    expect(chamadas[1]?.corpo).toEqual({ title: '', artist: '', nome: '01 - Faixa Boa' });
  });

  it('manda o título escolhido quando há um', async () => {
    const { impl, chamadas } = fetchFalso({});
    await new AcervoUploader({ enviarBytes: async () => {}, fetchImpl: impl, esperar: semEspera }).enviar(
      arquivo,
      { titulo: 'Eu Escolhi', artista: 'Eu' },
    );

    expect(chamadas[1]?.corpo).toMatchObject({ title: 'Eu Escolhi', artist: 'Eu' });
  });

  it('acompanha pending até ready', async () => {
    const { impl, chamadas } = fetchFalso({
      ingest: [
        resposta(200, { id: 'job-1', status: 'pending' }),
        resposta(200, { id: 'job-1', status: 'processing' }),
        resposta(200, { id: 'job-1', status: 'ready', trackId: 'acervo:7' }),
      ],
    });
    const trackId = await new AcervoUploader({
      enviarBytes: async () => {},
      fetchImpl: impl,
      esperar: semEspera,
    }).enviar(arquivo);

    expect(trackId).toBe('acervo:7');
    expect(chamadas.filter((c) => c.url.includes('/ingest/'))).toHaveLength(3);
  });

  it('repassa a mensagem da API quando o arquivo é grande demais', async () => {
    const { impl } = fetchFalso({ upload: resposta(413, { error: 'arquivo grande demais: o limite é 60 MB' }) });
    const enviarBytes = vi.fn();

    await expect(
      new AcervoUploader({ enviarBytes, fetchImpl: impl, esperar: semEspera }).enviar(arquivo),
    ).rejects.toThrow('o limite é 60 MB');
    // E não gastou o upload do usuário para descobrir isso.
    expect(enviarBytes).not.toHaveBeenCalled();
  });

  it('marca semSessao quando a sessão cai no meio do envio', async () => {
    const { impl } = fetchFalso({ finalizar: resposta(401, { error: 'sessão expirada' }) });
    const erro = await new AcervoUploader({
      enviarBytes: async () => {},
      fetchImpl: impl,
      esperar: semEspera,
    })
      .enviar(arquivo)
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(AcervoError);
    expect((erro as AcervoError).semSessao).toBe(true);
  });

  it('repassa o erro da ingestão', async () => {
    const { impl } = fetchFalso({
      ingest: [resposta(200, { id: 'job-1', status: 'error', error: 'o arquivo não tem faixa de áudio' })],
    });
    await expect(
      new AcervoUploader({ enviarBytes: async () => {}, fetchImpl: impl, esperar: semEspera }).enviar(
        arquivo,
      ),
    ).rejects.toThrow('não tem faixa de áudio');
  });

  it('desiste de acompanhar sem chamar o envio de falha definitiva', async () => {
    const { impl } = fetchFalso({ ingest: [resposta(200, { id: 'job-1', status: 'pending' })] });
    await expect(
      new AcervoUploader({ enviarBytes: async () => {}, fetchImpl: impl, esperar: semEspera }).enviar(
        arquivo,
        { prazoMs: 0 },
      ),
    ).rejects.toThrow('processamento está demorando');
  });

  it('não deixa a fração passar de 1 se o enviador exagerar', async () => {
    const { impl } = fetchFalso({});
    const progresso: ProgressoEnvio[] = [];
    await new AcervoUploader({
      // XHR às vezes reporta o tamanho do corpo, não o do arquivo.
      enviarBytes: async (_u, _a, aoProgredir) => aoProgredir(99999),
      fetchImpl: impl,
      esperar: semEspera,
    }).enviar(arquivo, { aoMudar: (p) => progresso.push(p) });

    expect(progresso.every((p) => p.fracao <= 1)).toBe(true);
  });

  it('propaga falha do PUT no bucket', async () => {
    const { impl } = fetchFalso({});
    await expect(
      new AcervoUploader({
        enviarBytes: async () => {
          throw new Error('o R2 recusou o envio (403)');
        },
        fetchImpl: impl,
        esperar: semEspera,
      }).enviar(arquivo),
    ).rejects.toThrow('403');
  });
});
