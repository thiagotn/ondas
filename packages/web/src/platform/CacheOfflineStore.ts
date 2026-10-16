import type { OfflineStore, OfflineUsage } from '@ondas/core';

const CACHE_NAME = 'ondas-offline';
const keyOf = (id: string) => '/offline/' + id;

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

  async put(id: string, url: string, onProgress?: (p: number) => void): Promise<number> {
    await this.requestPersistence();
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error('download falhou (' + res.status + ')');
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let lastTick = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      // Sem content-length, 6 MB serve de régua otimista (como no protótipo).
      if (onProgress && Date.now() - lastTick > 150) {
        lastTick = Date.now();
        onProgress(total ? received / total : Math.min(0.95, received / 6e6));
      }
    }
    const blob = new Blob(chunks as BlobPart[], {
      type: res.headers.get('content-type') || 'audio/mpeg',
    });
    const c = await this.cache();
    if (c) await c.put(keyOf(id), new Response(blob));
    onProgress?.(1);
    return blob.size;
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
