import { useState } from 'react';
import { postJson } from '../lib/api';
import { notify } from '../lib/notify';
import { useAuth } from '../context/auth';
import { useSchedule } from '../context/schedule';

/**
 * A claim stamped less than this ago belongs to a copy that is still running
 * in another request (the whole copy is one serverless invocation), not to a
 * plan that is already on the calendar.
 */
const IN_FLIGHT_MS = 60_000;

/**
 * The starter-template copy flow, shared by the onboarding welcome flow and
 * the getting-started checklist.
 */
export function useTemplateCopy() {
  const { refreshProfile } = useAuth();
  const { refreshEvents } = useSchedule();
  const [isCopying, setIsCopying] = useState(false);

  const copyTemplate = async () => {
    setIsCopying(true);
    try {
      const result = await postJson<{ events?: number; alreadyCopied?: boolean; copiedAt?: string | null }>(
        '/api/template-copy', {}, 'Copying starter workouts',
      );
      // The re-check: whatever the answer, the calendar and profile are
      // refetched before anything is claimed about them.
      await Promise.all([refreshEvents(), refreshProfile()]);
      if (!result.alreadyCopied) {
        notify(`Added ${result.events ?? 0} recurring workouts`);
        return;
      }
      // Someone else holds the claim. Only a stamp old enough to have settled
      // means the plan is really there — a fresh one (or a null one, from a
      // claim just released by a failed copy) means it is not, yet.
      const stamped = result.copiedAt ? Date.parse(result.copiedAt) : NaN;
      notify(Number.isFinite(stamped) && Date.now() - stamped > IN_FLIGHT_MS
        ? 'Already copied'
        : 'Copy already under way — reload in a moment.');
    } catch {
      /* postJson already toasted */
    } finally {
      setIsCopying(false);
    }
  };

  return { copyTemplate, isCopying };
}
