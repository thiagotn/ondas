import { t } from '@ondas/core';
import type { OfflineStore, OfflineUsage } from '@ondas/core';

const CACHE_NAME = 'ondas-offline';
/**
 * Chave do cache. A barra inicial não é enfeite: ids do acervo têm a forma
 * `acervo:<uuid>`, e sem o `/offline/` na frente o `acervo:` seria lido como
 * ESQUEMA de URL (`new URL('acervo:123')` é uma URL válida e absurda). Com o
 * prefixo, o `:` cai no segundo segmento do caminho, onde é legal.
 */
const keyOf = (id: string) => '/offline/' + id;

/**
 * O aparelho encheu?
 *
 * Mora aqui, e não no controller, porque o nome do erro é coisa de navegador:
 * o padrão é `QuotaExceededError`, e o Firefox antigo mandava
 * `NS_ERROR_DOM_QUOTA_REACHED`. Quem chama só quer saber se a mensagem é
 * "sem espaço" ou "sem rede" — são saídas diferentes para a pessoa.
 */
/**
 * Sem o primeiro byte neste tempo, o rádio não está lá.
 *
 * Isto nasceu junto com o buffer deixar de consultar `navigator.onLine`: ele
 * passou a tentar baixar em cenários onde antes nem começava, e um `fetch` nu
 * numa rede dormindo fica pendurado sem erro nenhum. Enquanto ele pendura, o
 * controller trata a faixa como "já em download" e não tenta de novo pelo
 * resto da sessão — e o cano aberto ainda disputa banda com o stream que está
 * tocando, que é a última coisa que se quer num rádio em economia de energia.
 */
const ESPERA_PRIMEIRO_BYTE_MS = 15_000;

/**
 * Já começou, mas parou de chegar: o cano morreu em silêncio.
 *
 * O relógio é de INATIVIDADE, rearmado a cada pedaço — e não um prazo total,
 * que estouraria sozinho num set de uma hora em link lento e transformaria o
 * conserto em regressão.
 */
const ESPERA_ENTRE_PEDACOS_MS = 20_000;

export function ehCotaExcedida(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

/**
 * Faixas baixadas na Cache API. O Service Worker não intercepta estas chaves:
 * quem escreve e lê é sempre esta classe, então o índice em `library` e os
 * bytes no cache não divergem.
 */
export class CacheOfflineStore implements OfflineStore {
  /** Object URLs vivos, para revogar quando a faixa sai de cena. */
  private urls = new Map<string, string>();
  private persistRequested = false;

  private async cache(): Promise<Cache | null> {
    if (!('caches' in globalThis)) return null;
    try {
      return await caches.open(CACHE_NAME);
    } catch {
      return null;
    }
  }

  async has(id: string): Promise<boolean> {
    const c = await this.cache();
    if (!c) return false;
    return !!(await c.match(keyOf(id)));
  }

  async get(id: string): Promise<string | null> {
    const existing = this.urls.get(id);
    if (existing) return existing;
    const c = await this.cache();
    if (!c) return null;
    const res = await c.match(keyOf(id));
    if (!res) return null;
    const url = URL.createObjectURL(await res.blob());
    this.urls.set(id, url);
    return url;
  }

  /**
   * Baixa e grava **em fluxo**: os bytes passam da rede para a Cache API sem
   * parar num array no meio.
   *
   * A versão anterior acumulava todos os pedaços e montava um `Blob` no fim —
   * medido: um arquivo de 54,9 MB virava um único Blob de 54,9 MB, mais a
   * cópia da construção. Para uma faixa de 4 minutos não faz diferença; para
   * um set de uma hora (~120 MB) é o pico que o sistema usa para escolher qual
   * aba matar no celular.
   *
   * O `TransformStream` conta os bytes de passagem, então a barra de progresso
   * continua funcionando sem segurar nada: a contrapressão é do próprio cano —
   * se o disco não acompanha a rede, a leitura desacelera junto.
   */
  async put(id: string, url: string, onProgress?: (p: number) => void): Promise<number> {
    await this.requestPersistence();
    const c = await this.cache();
    // Sem Cache API não existe offline. Antes isto devolvia o tamanho como se
    // tivesse gravado, e a faixa ficava marcada `[off]` sem bytes nenhum
    // atrás (o `reconcile` do boot acabava desfazendo).
    if (!c) throw new Error(t('erro.semOffline'));

    // Cão de guarda: cada pedaço que chega rearma o relógio, e o silêncio
    // derruba o `fetch`. Quem chama trata o `AbortError` como qualquer outra
    // falha de download — o buffer silencioso tenta de novo na faixa seguinte,
    // porque o `catch` do controller limpa o progresso.
    const abortador = new AbortController();
    let relogio: ReturnType<typeof setTimeout> | undefined;
    const rearmar = (ms: number) => {
      clearTimeout(relogio);
      relogio = setTimeout(() => abortador.abort(), ms);
    };

    try {
      rearmar(ESPERA_PRIMEIRO_BYTE_MS);
      const res = await fetch(url, { signal: abortador.signal });
      if (!res.ok || !res.body) throw new Error('download falhou (' + res.status + ')');
      const total = Number(res.headers.get('content-length')) || 0;

      let recebidos = 0;
      let ultimoAviso = 0;
      const contador = new TransformStream<Uint8Array, Uint8Array>({
        transform(pedaco, controlador) {
          rearmar(ESPERA_ENTRE_PEDACOS_MS);
          recebidos += pedaco.byteLength;
          // Sem content-length, 6 MB serve de régua otimista (como no protótipo).
          if (onProgress && Date.now() - ultimoAviso > 150) {
            ultimoAviso = Date.now();
            onProgress(total ? recebidos / total : Math.min(0.95, recebidos / 6e6));
          }
          controlador.enqueue(pedaco);
        },
        flush() {
          // O último byte chegou: gravar em disco pode demorar, e derrubar a
          // gravação por "inatividade de rede" seria perder o download no fim.
          clearTimeout(relogio);
        },
      });

      const corpo = new Response(res.body.pipeThrough(contador), {
        headers: { 'content-type': res.headers.get('content-type') || 'audio/mpeg' },
      });
      try {
        await c.put(keyOf(id), corpo);
      } catch (err) {
        // Cota estourada no meio da gravação: a entrada não serve para nada, e
        // deixá-la faria o `reconcile` do boot jurar que a faixa está no
        // aparelho. Apagar antes de propagar.
        await c.delete(keyOf(id)).catch(() => {});
        throw err;
      }
      onProgress?.(1);
      return recebidos;
    } finally {
      clearTimeout(relogio);
    }
  }

  async remove(id: string): Promise<void> {
    const url = this.urls.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      this.urls.delete(id);
    }
    const c = await this.cache();
    if (c) await c.delete(keyOf(id));
  }

  async usage(): Promise<OfflineUsage> {
    let quota: number | undefined;
    let bytes = 0;
    try {
      const est = await navigator.storage?.estimate?.();
      quota = est?.quota;
      bytes = est?.usage ?? 0;
    } catch {
      /* alguns navegadores não expõem a estimativa */
    }
    return quota == null ? { bytes } : { bytes, quota };
  }

  async keys(): Promise<string[]> {
    const c = await this.cache();
    if (!c) return [];
    const reqs = await c.keys();
    return reqs
      .map((r) => new URL(r.url).pathname)
      .filter((p) => p.startsWith('/offline/'))
      .map((p) => p.slice('/offline/'.length));
  }

  /** Pede armazenamento persistente na primeira gravação (o iOS evacua PWAs ociosas). */
  private async requestPersistence(): Promise<void> {
    if (this.persistRequested) return;
    this.persistRequested = true;
    try {
      if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
        await navigator.storage.persist();
      }
    } catch {
      /* sem suporte: segue sem garantia */
    }
  }

  /**
   * Marca uma faixa sem `stream` (catálogo demo) como presente no aparelho.
   * Grava uma resposta vazia só para a chave existir: assim a reconciliação do
   * boot não derruba o download, e a faixa continua tocando em modo simulado.
   */
  async putPlaceholder(id: string): Promise<void> {
    const c = await this.cache();
    if (!c) return;
    await c.put(keyOf(id), new Response(new Blob([], { type: 'audio/x-ondas-sim' })));
  }

  /** Libera o object URL de uma faixa que saiu de cena. */
  releaseUrl(id: string): void {
    const url = this.urls.get(id);
    if (!url) return;
    URL.revokeObjectURL(url);
    this.urls.delete(id);
  }
}
