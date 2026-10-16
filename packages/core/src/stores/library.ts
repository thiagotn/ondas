import { createStore } from 'zustand/vanilla';

/** O que é persistido da biblioteca entre sessões. */
export interface LibrarySnapshot {
  liked: Record<string, boolean>;
  cached: Record<string, boolean>;
  sizes: Record<string, number>;
  prefetch: boolean;
}

export interface LibraryState extends LibrarySnapshot {
  /** Downloads em andamento: id → progresso 0..1. */
  dl: Record<string, number>;
  toggleLike(id: string): void;
  markCached(id: string, size: number): void;
  unmarkCached(id: string): void;
  /** `null` encerra o acompanhamento do download. */
  setDl(id: string, progress: number | null): void;
  togglePrefetch(): void;
  /** Substitui o índice `cached`/`sizes` pelo que existe de fato no aparelho. */
  reconcile(presentIds: string[]): void;
  hydrate(snapshot: Partial<LibrarySnapshot>): void;
}

export type LibraryStore = ReturnType<typeof createLibraryStore>;

export interface LibraryStoreOptions {
  initial?: Partial<LibrarySnapshot>;
  /** Chamado após cada mutação persistível. */
  persist?: (snapshot: LibrarySnapshot) => void;
}

const snapshotOf = (s: LibraryState): LibrarySnapshot => ({
  liked: s.liked,
  cached: s.cached,
  sizes: s.sizes,
  prefetch: s.prefetch,
});

export function createLibraryStore(options: LibraryStoreOptions = {}) {
  const { persist } = options;
  const store = createStore<LibraryState>((set, get) => {
    /** Aplica a mutação e persiste o resultado. */
    const commit = (fn: (s: LibraryState) => Partial<LibraryState>) => {
      set(fn);
      persist?.(snapshotOf(get()));
    };
    return {
      liked: options.initial?.liked ?? {},
      cached: options.initial?.cached ?? {},
      sizes: options.initial?.sizes ?? {},
      prefetch: options.initial?.prefetch ?? true,
      dl: {},
      toggleLike: (id) =>
        commit((s) => {
          const liked = { ...s.liked };
          if (liked[id]) delete liked[id];
          else liked[id] = true;
          return { liked };
        }),
      markCached: (id, size) =>
        commit((s) => ({ cached: { ...s.cached, [id]: true }, sizes: { ...s.sizes, [id]: size } })),
      unmarkCached: (id) =>
        commit((s) => {
          const cached = { ...s.cached };
          const sizes = { ...s.sizes };
          delete cached[id];
          delete sizes[id];
          return { cached, sizes };
        }),
      setDl: (id, progress) =>
        set((s) => {
          const dl = { ...s.dl };
          if (progress == null) delete dl[id];
          else dl[id] = progress;
          return { dl };
        }),
      togglePrefetch: () => commit((s) => ({ prefetch: !s.prefetch })),
      reconcile: (presentIds) =>
        commit((s) => {
          const present = new Set(presentIds);
          const cached: Record<string, boolean> = {};
          const sizes: Record<string, number> = {};
          for (const id of Object.keys(s.cached)) {
            if (!present.has(id)) continue;
            cached[id] = true;
            if (s.sizes[id] != null) sizes[id] = s.sizes[id]!;
          }
          return { cached, sizes };
        }),
      hydrate: (snapshot) => set({ ...snapshot }),
    };
  });
  return store;
}

/** Total de bytes das faixas no aparelho. */
export function offlineBytes(s: Pick<LibraryState, 'cached' | 'sizes'>): number {
  return Object.keys(s.cached).reduce((acc, id) => acc + (s.sizes[id] ?? 0), 0);
}
