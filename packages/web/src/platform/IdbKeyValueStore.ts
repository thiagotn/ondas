import type { KeyValueStore } from '@ondas/core';
import { createStore, del, get, set } from 'idb-keyval';

const store = createStore('ondas', 'kv');
const PREFIX = 'ondas-';

/** `KeyValueStore` em IndexedDB. Sobrevive a mais coisas que o localStorage no iOS. */
export class IdbKeyValueStore implements KeyValueStore {
  async get<T>(key: string): Promise<T | undefined> {
    try {
      return await get<T>(PREFIX + key, store);
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    try {
      await set(PREFIX + key, value, store);
    } catch {
      // Modo privado / cota cheia: a sessão segue, só não persiste.
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await del(PREFIX + key, store);
    } catch {
      /* idem */
    }
  }
}
