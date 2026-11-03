import { useOverlayParam } from './useOverlayParam';

/** A janela do sobre é o overlay `?about=1`. */
export function useAboutOverlay() {
  const { open, show, hide } = useOverlayParam('about');
  return { isAboutOpen: open, openAbout: show, closeAbout: hide };
}
