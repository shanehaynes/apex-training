import { useEffect } from 'react';
import type { TipId } from '../lib/onboarding/tips/index';
import { registerTip } from '../lib/onboarding/tipsStore';

/**
 * Offer tip `id` for as long as the calling component is mounted and `when`
 * holds. Renders nothing and decides nothing: TipHost picks at most one
 * candidate per page load, skips tips this account has already seen, and
 * waits for the screen to settle (docs/onboarding/MASTER.md, "Tips").
 *
 * Call it at the site a feature is first reached. Passing `when` at all —
 * even a literal `true` — marks the tip as conditioned: the feature is saying
 * "now", which wins a tie against a tip that only rides along with a mount.
 */
export function useTip(id: TipId, when?: boolean): void {
  const conditioned = when !== undefined;
  const active = when ?? true;
  useEffect(() => {
    if (!active) return;
    return registerTip(id, conditioned);
  }, [id, active, conditioned]);
}
