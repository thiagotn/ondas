/** Estado de rede: `navigator.onLine` na web, NetInfo no nativo. */
export interface Connectivity {
  isOnline(): boolean;
  subscribe(cb: (online: boolean) => void): () => void;
}
