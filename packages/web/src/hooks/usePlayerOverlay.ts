import { useOverlayParam } from './useOverlayParam';

/** O full player é o overlay `?player=1`. */
export function usePlayerOverlay() {
  const { open, show, hide } = useOverlayParam('player');
  return { isPlayerOpen: open, openPlayer: show, closePlayer: hide };
}
