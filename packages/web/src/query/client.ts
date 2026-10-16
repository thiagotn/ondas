import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient } from '@tanstack/react-query';
import { createStore, del, get, set } from 'idb-keyval';

/**
 * Banco próprio: um `createStore` só cria o object store quando o banco nasce,
 * então dividir o banco `ondas` (usado pelo KeyValueStore) com outro store
 * falharia com NotFoundError.
 */
const idb = createStore('ondas-query', 'cache');

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,
      gcTime: 24 * 60 * 60_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Cache de queries em IndexedDB: a PWA abre com o catálogo da última sessão
 * mesmo sem rede, antes de qualquer fetch.
 */
export const queryPersister = createAsyncStoragePersister({
  storage: {
    getItem: (key) => get<string>(key, idb).then((v) => v ?? null),
    setItem: (key, value) => set(key, value, idb),
    removeItem: (key) => del(key, idb),
  },
  key: 'ondas-query-cache',
  throttleTime: 1000,
});
