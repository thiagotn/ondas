import type { Connectivity } from '@ondas/core';

/** `navigator.onLine` + eventos `online`/`offline`. */
export class BrowserConnectivity implements Connectivity {
  isOnline(): boolean {
    return navigator.onLine;
  }

  subscribe(cb: (online: boolean) => void): () => void {
    const on = () => cb(true);
    const off = () => cb(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }
}
