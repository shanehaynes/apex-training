import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useAuth } from '../../context/auth';
import { TIPS, isTipId, tipById, type TipId } from '../../lib/onboarding/tips/index';
import { pickTip, tipsEligible } from '../../lib/onboarding/tipHost';
import { getTipCandidates, registerTip, subscribeTipCandidates } from '../../lib/onboarding/tipsStore';
import TipCard from './TipCard';

// The arbiter (docs/onboarding/MASTER.md, "Tips — catalog + arbiter"): of the
// tips the screen is offering through useTip(), show at most one, once, when
// the screen is ready for it.
//
// Mounted by OnboardingHost below its WelcomeFlow return, so a tip can never
// sit over the intro; and regardless of which overlay is open, because the
// overlays are where the features — and so the tips — live.

/** Long enough for an overlay's framer entrance to finish before a card lands on it. */
const SETTLE_MS = 600;
/** Below this the on-screen keyboard is probably up; a card would hide what the user is typing into. */
const MIN_VIEWPORT_HEIGHT = 500;

interface TipsWindow {
  /** Kill switch. Set by the e2e fixture for every spec that does not opt in to tips. */
  __APEX_TIPS_OFF__?: boolean;
  /** e2e only: offer this tip id (or `true` for the catalog's first) as if a feature had called useTip. */
  __APEX_TIPS_DEMO__?: boolean | string;
}
const tipsWindow = () => window as unknown as TipsWindow;

// One tip per page load: a new user who meets three features in a minute
// learns about one of them, not three in a row. Module-level so it survives
// TipHost remounting (sign-out and back in, say) within the same load.
let shownThisLoad = false;

/** Whether now is a bad moment: keyboard up, or the user is mid-typing. */
function busyNow(): boolean {
  const height = window.visualViewport?.height;
  if (height !== undefined && height < MIN_VIEWPORT_HEIGHT) return true;
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

export default function TipHost() {
  const { profile, tipsSeen, markTipSeen } = useAuth();
  const candidates = useSyncExternalStore(subscribeTipCandidates, getTipCandidates);
  const [active, setActive] = useState<TipId | null>(null);

  // e2e hook: the tips spec asks the host to offer a tip itself, the way a
  // feature's useTip would. Registered as conditioned so it wins the tie
  // against a real tip of the same priority that the calendar underneath is
  // offering. Inert unless a test's init script sets it.
  useEffect(() => {
    const demo = tipsWindow().__APEX_TIPS_DEMO__;
    if (!demo) return;
    return registerTip(isTipId(demo) ? demo : TIPS[0].id, true);
  }, []);

  // While the e2e demo hook is set, only the demo tip is on offer: the spec is
  // proving the mechanism, and every feature under the page offers its own
  // real tips, which would otherwise take the one slot per load.
  const demo = tipsWindow().__APEX_TIPS_DEMO__;
  const demoId = demo ? (isTipId(demo) ? demo : TIPS[0].id) : null;
  const offered = demoId ? candidates.filter(c => c.id === demoId) : candidates;

  const winner = active === null && !shownThisLoad && tipsEligible(profile, !!tipsWindow().__APEX_TIPS_OFF__)
    ? pickTip(offered, tipsSeen, TIPS)
    : null;

  // Settle, then show — unless the moment is wrong, in which case wait for
  // the viewport or focus to change and settle again. A different winner
  // (or none) restarts all of it.
  useEffect(() => {
    if (!winner) return;
    const vv = window.visualViewport;
    let timer = setTimeout(attempt, SETTLE_MS);
    let listening = false;

    function recheck() {
      clearTimeout(timer);
      timer = setTimeout(attempt, SETTLE_MS);
    }
    function listen(on: boolean) {
      if (on === listening) return;
      listening = on;
      const method = on ? 'addEventListener' : 'removeEventListener';
      vv?.[method]('resize', recheck);
      window[method]('resize', recheck);
      document[method]('focusin', recheck);
      document[method]('focusout', recheck);
    }
    function attempt() {
      if (busyNow()) { listen(true); return; }
      listen(false);
      shownThisLoad = true;
      setActive(winner);
    }

    return () => { clearTimeout(timer); listen(false); };
  }, [winner]);

  const done = useCallback(() => {
    if (active) markTipSeen(active);
    setActive(null);
  }, [active, markTipSeen]);

  if (!active) return null;
  return <TipCard key={active} tip={tipById(active)} onDone={done} />;
}
