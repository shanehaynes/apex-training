import { CHECKLIST_ITEMS, type ChecklistId, type ChecklistItem } from './content.js';

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

// A row the user does not want to do can be skipped. The skip is a one-way
// latch with the same lifetime as a dismissed tip, so it is stored the same
// way: a `setup-skip:<id>` key in profiles.tips_seen (and the device mirror),
// which crosses devices with no column of its own.
const SKIP_PREFIX = 'setup-skip:';

export type SetupSkipId = `${typeof SKIP_PREFIX}${ChecklistId}`;

export function setupSkipId(id: ChecklistId): SetupSkipId {
  return `${SKIP_PREFIX}${id}`;
}

export function isChecklistId(value: unknown): value is ChecklistId {
  return typeof value === 'string' && CHECKLIST_ITEMS.some(item => item.id === value);
}

export function isSetupSkipId(value: unknown): value is SetupSkipId {
  return typeof value === 'string' && value.startsWith(SKIP_PREFIX)
    && isChecklistId(value.slice(SKIP_PREFIX.length));
}

export function isSkipped(id: ChecklistId, seen: ReadonlySet<string>): boolean {
  return seen.has(setupSkipId(id));
}

/** The skipped rows among a set of seen ids, in checklist order. */
export function skippedIds(seen: ReadonlySet<string>): ChecklistId[] {
  return CHECKLIST_ITEMS.map(item => item.id).filter(id => isSkipped(id, seen));
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
  /** Skipped by the user: neither done nor owed, and listed last so it can be undone. */
  skipped: boolean;
}

/** Skipped rows come last, kept so the list can offer to undo them. */
export function checklistRows(
  local: LocalSignals, remote: RemoteSignals, seen: ReadonlySet<string> = new Set(),
): ProgressRow[] {
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
    .map(item => {
      const done = doneFor(item.id);
      // Done anyway after a skip: it is done, and there is nothing to undo.
      return { ...item, done, skipped: !done && isSkipped(item.id, seen) };
    })
    // Stable: catalog order within each group.
    .sort((a, b) => Number(a.skipped) - Number(b.skipped));
}
