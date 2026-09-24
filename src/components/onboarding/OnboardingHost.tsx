import { useAuth } from '../../context/auth';
import { useCalendar } from '../../context/calendar';
import WelcomeFlow from './WelcomeFlow';
import { SetupNudge } from './GettingStarted';
import TipHost from './TipHost';

// Single mount point for first-run UI, so AppShell keeps one line for
// onboarding the way it had one line for the old template banner.

export default function OnboardingHost() {
  const { profile } = useAuth();
  const { state } = useCalendar();

  // The template source is Shane's own account — already set up by definition.
  if (!profile || profile.is_template_source) return null;

  // Everything below this line waits for the intro to be done — which is what
  // guarantees a tip never sits over it.
  if (!profile.onboarding_dismissed_at) return <WelcomeFlow />;

  // Every "page" in this app is a full-screen overlay, and the nudge is
  // position: fixed — without this it would float over the tracker mid-set.
  const overlayOpen = !!(
    state.selectedEvent || state.selectedDay || state.composerDate ||
    state.mealComposerDate || state.trackingSession ||
    state.libraryOpen || state.blocksOpen || state.profileOpen
  );

  // TipHost ignores overlayOpen: overlays are where the features, and so the
  // tips, are. It keeps its slot either way so a showing tip is not remounted.
  return (
    <>
      {!overlayOpen && <SetupNudge />}
      <TipHost />
    </>
  );
}
