import { createStore } from 'zustand/vanilla';
import type { Playlist } from '../types.js';

/**
 * O que é persistido da biblioteca entre sessões.
 *
 * Os campos NÃO têm o mesmo dono, e a diferença virou importante: `cached`,
 * `sizes` e `prefetch` são deste aparelho (os bytes estão nele), mas `liked` e
 * `playlists` são da CONTA — o servidor é o dono, e o que fica aqui é espelho,
 * pelo mesmo motivo do espelho de sessão em `auth/http.ts`: a PWA abre offline e
 * precisa desenhar o coração e a fileira de playlists antes de falar com alguém.
 *
 * Daí sair da conta zerar os dois e não tocar no resto (`controller.logout`):
 * curtidas e playlists estão no servidor e voltam no próximo login; os bytes
 * não estão em lugar nenhum além daqui.
 */
export interface LibrarySnapshot {
  /** Espelho das curtidas da conta; o dono é o servidor (`/api/likes`). */
  liked: Record<string, boolean>;
  /**
   * Espelho das playlists da conta; o dono é o servidor (`/api/playlists`).
   *
   * Array e não mapa por id porque a ORDEM das playlists também é dado — é a
   * ordem em que foram criadas, e é a que o índice e o seletor mostram.
   *
   * Ao contrário de `liked`, este espelho não tem adoção a fazer: playlist
   * nunca existiu neste aparelho antes de existir no servidor, então não há
   * nada de antes para carregar (ver `ADOTADAS_KEY` em `app/likes.ts`).
   */
  playlists: Playlist[];
  cached: Record<string, boolean>;
  sizes: Record<string, number>;
  prefetch: boolean;
}

export interface LibraryState extends LibrarySnapshot {
  /** Downloads em andamento: id → progresso 0..1. */
  dl: Record<string, number>;
  toggleLike(id: string): void;
  /**
   * Troca o mapa inteiro pela lista que o servidor mandou.
   *
   * Passa pelo `commit`, ao contrário de `hydrate`: isto NÃO é "li o disco", é
   * "o dono falou", e o espelho no disco tem de concordar com a tela antes do
   * próximo boot offline. É também o que o logout usa, com lista vazia.
   */
  setLiked(ids: readonly string[]): void;
  /**
   * Troca a coleção inteira pela que o servidor mandou.
   *
   * Sempre a coleção inteira, nunca uma playlist só: é o que TODA resposta da
   * API devolve, justamente para não existir uma segunda leitura capaz de
   * discordar da escrita. Também é o que o logout usa, com lista vazia.
   */
  setPlaylists(playlists: readonly Playlist[]): void;
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
  playlists: s.playlists,
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
      playlists: options.initial?.playlists ?? [],
      cached: options.initial?.cached ?? {},
      sizes: options.initial?.sizes ?? {},
      prefetch: options.initial?.prefetch ?? true,
      dl: {},
      setLiked: (ids) =>
        commit(() => ({ liked: Object.fromEntries(ids.map((id) => [id, true])) })),
      setPlaylists: (playlists) => commit(() => ({ playlists: [...playlists] })),
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
