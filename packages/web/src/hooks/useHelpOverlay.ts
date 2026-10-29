import { useOverlayParam } from './useOverlayParam';

/** A janela de atalhos é o overlay `?atalhos=1`. */
export function useHelpOverlay() {
  const { open, show, hide } = useOverlayParam('shortcuts');
  return { isHelpOpen: open, openHelp: show, closeHelp: hide };
}
