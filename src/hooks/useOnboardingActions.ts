import { useCalendar } from '../context/calendar';
import { useTemplateCopy } from './useTemplateCopy';
import { useProviderSync } from './useProviderSync';
import type { ActionKind } from '../lib/onboarding/content';

/**
 * Maps the ActionKind on a step or checklist row to the hook that already
 * owns that flow — onboarding adds no second implementation of copying the
 * template or starting the COROS handshake, it just calls them.
 *
 * Sole owner of useProviderSync within onboarding: every mount of that hook
 * POSTs its own status request, so useOnboardingProgress composes THIS hook
 * rather than calling useProviderSync a second time.
 */
export function useOnboardingActions() {
  const { dispatch } = useCalendar();
  const { copyTemplate, isCopying } = useTemplateCopy();
  const { startConnect, isConnecting, status: corosStatus, configured: corosConfigured } = useProviderSync();

  const run = (kind: ActionKind) => {
    switch (kind) {
      case 'copy-template': return copyTemplate();
      case 'open-profile': return dispatch({ type: 'OPEN_PROFILE' });
      case 'connect-coros': return startConnect();
    }
  };

  const isBusy = (kind: ActionKind): boolean => (
    (kind === 'copy-template' && isCopying) || (kind === 'connect-coros' && isConnecting)
  );

  return { run, isBusy, corosStatus, corosConfigured };
}
