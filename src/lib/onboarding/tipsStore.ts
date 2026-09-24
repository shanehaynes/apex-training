import type { TipId } from './tips/index';
import type { TipCandidate } from './tipHost';

// The tips' two pieces of client state, neither of which is React state.
//
// 1. Candidates: which tips the screen currently wants to show. A module-level
//    store rather than a context, so useTip() works from any component without
//    a provider in App.tsx or AppShell.tsx — the same shape as lib/notify.ts,
//    which Toasts.tsx reads through useSyncExternalStore. useTip registers,
//    TipHost subscribes.
// 2. The localStorage mirror of "seen" (D-O01): always written, so a dismissed
//    tip stays dismissed on this device even before profiles.tips_seen exists
//    in prod. AuthContext owns when it is read and written. It is never
//    cleared on sign-out: it is keyed per user and holds only tip ids, and
//    clearing it would bring every seen tip back until the column is in prod.

// ── Candidates ────────────────────────────────────────────────────────────────

interface Registration extends TipCandidate {
  token: number;
}

let nextToken = 1;
let registrations: readonly Registration[] = [];
let snapshot: readonly TipCandidate[] = [];
const listeners = new Set<() => void>();

function emit() {
  // One entry per id: two mounted components asking for the same tip are one
  // candidate, conditioned if either of them is.
  const byId = new Map<TipId, TipCandidate>();
  for (const r of registrations) {
    const prev = byId.get(r.id);
    byId.set(r.id, { id: r.id, conditioned: r.conditioned || !!prev?.conditioned });
  }
  snapshot = [...byId.values()];
  for (const listener of listeners) listener();
}

/** Put a tip forward. Returns the matching withdrawal. */
export function registerTip(id: TipId, conditioned: boolean): () => void {
  const token = nextToken++;
  registrations = [...registrations, { id, conditioned, token }];
  emit();
  return () => {
    if (!registrations.some(r => r.token === token)) return;
    registrations = registrations.filter(r => r.token !== token);
    emit();
  };
}

export function getTipCandidates(): readonly TipCandidate[] {
  return snapshot;
}

export function subscribeTipCandidates(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// ── Local "seen" mirror ───────────────────────────────────────────────────────

// Per user, like lib/schedule/localCompletion.ts: on a shared device one
// account's dismissals must not hide another account's tips.
const LS_PREFIX = 'apex:tips-seen:';

/** Tip id → ISO time, as stored for this user; {} when absent or unreadable. */
export function loadLocalTipsSeen(userId: string | null): Record<string, string> {
  if (!userId) return {};
  try {
    const raw = localStorage.getItem(LS_PREFIX + userId);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, string>
      : {};
  } catch {
    return {};
  }
}

export function saveLocalTipSeen(userId: string | null, id: TipId, at: string) {
  if (!userId) return;
  try {
    localStorage.setItem(LS_PREFIX + userId, JSON.stringify({ ...loadLocalTipsSeen(userId), [id]: at }));
  } catch {}
}
