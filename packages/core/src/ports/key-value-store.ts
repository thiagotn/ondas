/** Persistência simples: idb-keyval na web, MMKV/AsyncStorage no nativo. */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}
