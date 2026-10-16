import { useEffect, useState } from 'react';
import { connectivity } from '../app/services';
import { setOnline } from '../app/controller';
import { useUi } from '../app/stores';

export interface NetworkState {
  /** Rede real do navegador. */
  online: boolean;
  /** Considerando a simulação de queda do build de dev. */
  offline: boolean;
}

export function useNetwork(): NetworkState {
  const [online, setOnlineState] = useState(() => connectivity.isOnline());
  const simulatedOffline = useUi((s) => s.simulatedOffline);

  useEffect(() => {
    setOnline(connectivity.isOnline());
    return connectivity.subscribe((value) => {
      setOnlineState(value);
      setOnline(value);
    });
  }, []);

  return { online, offline: !online || (import.meta.env.DEV && simulatedOffline) };
}
