import { useOverlayParam } from './useOverlayParam';

/** Conta e aparelho são o overlay `?conta=1`. */
export function useAccountOverlay() {
  const { open, show, hide } = useOverlayParam('conta');
  return { isAccountOpen: open, openAccount: show, closeAccount: hide };
}
