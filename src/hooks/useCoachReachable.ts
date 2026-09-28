import { useMediaQuery } from './useMediaQuery';

/**
 * Whether the coach pane can be put on screen at this viewport width.
 *
 * app.css hides `.app-sidebar` at 1024px and below; the Coach tab that
 * brings it back exists only on the phone layout (768px and below, where
 * AppShell renders MobileBottomNav). Between the two — tablets — the coach
 * is unreachable, regardless of this hook (a layout gap, not a feature's).
 * "Ask the coach" reads this so it never leaves the modal or tracker and
 * bills a turn nobody can open.
 */
export function useCoachReachable(): boolean {
  const sidebarHidden = useMediaQuery('(max-width: 1024px)');
  const hasCoachTab = useMediaQuery('(max-width: 768px)');
  return !sidebarHidden || hasCoachTab;
}
