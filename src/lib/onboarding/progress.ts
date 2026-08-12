import { CHECKLIST_ITEMS, type ChecklistId, type ChecklistItem } from './content';

// Setup progress, as pure functions over the signals the app already holds.
// Nothing here is self-reported: a row is ticked because the feature's own
// state says so, which is why adding a key from ProfileView ticks the key row
// without onboarding being told about it.
//
// Kept out of the hooks (which only wire context in) so it is unit-testable
// the same way records.ts and plan.ts are.

/** The three signals the browser already has in memory — no request needed. */
export interface LocalSignals {
  templateCopiedAt: string | null;
  /** null = /api/profile hasn't answered yet. */
  hasAnthropicKey: boolean | null;
  coachGoal: string;
}

export type LocalId = 'template' | 'key' | 'goal';

export function localSetupDone(signals: LocalSignals): Record<LocalId, boolean> {
  return {
    template: !!signals.templateCopiedAt,
    // Unknown counts as done: the nudge is fixed over the calendar, and
    // flashing it on every cold load before the key status lands is worse
    // than showing it a beat late.
    key: signals.hasAnthropicKey === null || signals.hasAnthropicKey,
    goal: !!signals.coachGoal.trim(),
  };
}

/** The two signals that cost a request, resolved by the caller. */
export interface RemoteSignals {
  corosConnected: boolean;
  corosConfigured: boolean;
  /** null = the token list hasn't answered yet. */
  hasConnector: boolean | null;
}

export interface ProgressRow extends ChecklistItem {
  done: boolean;
}

export function checklistRows(local: LocalSignals, remote: RemoteSignals): ProgressRow[] {
  const localDone = localSetupDone(local);

  const doneFor = (id: ChecklistId): boolean => {
    switch (id) {
      case 'template': return localDone.template;
      case 'key': return localDone.key;
      case 'goal': return localDone.goal;
      case 'coros': return remote.corosConnected;
      // Unknown reads as NOT done here, unlike the key above: this list only
      // renders on a screen the user opened, so a late tick beats a wrong one.
      case 'connector': return remote.hasConnector === true;
    }
  };

  return CHECKLIST_ITEMS
    // A deployment without COROS env vars hides the whole feature; promising
    // it in a checklist the user can never satisfy would be a dead end.
    .filter(item => !item.requiresCoros || remote.corosConfigured)
    .map(item => ({ ...item, done: doneFor(item.id) }));
}
