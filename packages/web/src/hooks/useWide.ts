import { useEffect, useState } from 'react';

/** Breakpoint único do handoff. */
export const WIDE_QUERY = '(min-width: 860px)';

/** `true` em viewport >= 860px: traffic lights, prefixos de aba, thumbs e legenda. */
export function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setWide(e.matches);
    mq.addEventListener('change', onChange);
    setWide(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return wide;
}
