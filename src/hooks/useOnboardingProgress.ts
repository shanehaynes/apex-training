import { useEffect, useState } from 'react';
import { useAuth } from '../context/auth';
import { useOnboardingActions } from './useOnboardingActions';
import { listMcpTokens } from '../lib/api';
import {
  checklistRows, isSkipped, localSetupDone, setupSkipId, type LocalId, type LocalSignals,
} from '../lib/onboarding/progress';
import type { ChecklistId } from '../lib/onboarding/content';

// Thin wiring only — the decisions live in lib/onboarding/progress.ts.

function signalsFrom(
  profile: { template_copied_at: string | null; coach_goal: string } | null,
  hasKey: boolean | null,
): LocalSignals {
  return {
    templateCopiedAt: profile?.template_copied_at ?? null,
    hasAnthropicKey: hasKey,
    coachGoal: profile?.coach_goal ?? '',
  };
}

/** Signals already in memory — no network, safe on every render of the calendar. */
export function useLocalSetupProgress() {
  const { profile, anthropicKey, tipsSeen } = useAuth();
  const done = localSetupDone(signalsFrom(profile, anthropicKey?.hasKey ?? null));
  const owed = (id: LocalId) => !done[id] && !isSkipped(id, tipsSeen);

  return {
    done,
    skipped: (id: LocalId) => isSkipped(id, tipsSeen),
    /** Fresh accounts only — the template source is Shane's own, set up by definition. */
    applies: !!profile && !profile.is_template_source,
    /** Nothing left to ask for: every row is done or skipped. */
    allDone: !owed('template') && !owed('key') && !owed('goal'),
  };
}

/** Skip a row for good, on every device. */
export function useSkipSetupRow() {
  const { markTipSeen } = useAuth();
  return (id: ChecklistId) => markTipSeen(setupSkipId(id));
}

/**
 * The full checklist, including the two rows that cost a request to resolve.
 * Only mount this where the extra calls are justified (ProfileView, which the
 * user opened deliberately) — the calendar uses useLocalSetupProgress instead.
 */
export function useOnboardingProgress() {
  const { profile, anthropicKey, tipsSeen } = useAuth();
  const actions = useOnboardingActions();
  const [hasConnector, setHasConnector] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    listMcpTokens()
      .then(({ tokens, connections }) => {
        if (cancelled) return;
        setHasConnector((tokens?.length ?? 0) > 0 || (connections?.length ?? 0) > 0);
      })
      .catch(() => { /* toasted by the api layer; unknown stays null */ });
    return () => { cancelled = true; };
  }, []);

  const rows = checklistRows(signalsFrom(profile, anthropicKey?.hasKey ?? null), {
    corosConnected: actions.corosStatus === 'connected',
    corosConfigured: actions.corosConfigured,
    hasConnector,
  }, tipsSeen);

  return {
    ...actions,
    rows,
    applies: !!profile && !profile.is_template_source,
    doneCount: rows.filter(r => r.done).length,
    allDone: rows.every(r => r.done),
  };
}
