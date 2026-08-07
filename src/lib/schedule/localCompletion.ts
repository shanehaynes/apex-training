// localStorage adapter for completion state — the offline fallback and
// first-paint cache behind ScheduleContext's completedIds.

// Keyed per user: on a shared device, one account's cached completions must
// not paint into another account's first render. Offline mode (no auth) has
// no user id and keeps the bare key.
const LS_KEY = 'apex-completed';

function keyFor(userId: string | null): string {
  return userId ? `${LS_KEY}:${userId}` : LS_KEY;
}

export function loadCompletedIds(userId: string | null): Set<string> {
  try {
    // Drop the legacy un-namespaced cache a signed-in session may have left
    // behind — it could belong to a different account.
    if (userId) localStorage.removeItem(LS_KEY);
    const raw = localStorage.getItem(keyFor(userId));
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function saveCompletedIds(userId: string | null, ids: Set<string>) {
  try { localStorage.setItem(keyFor(userId), JSON.stringify([...ids])); } catch {}
}

// Called on sign-out: the cache is per-account state and must not linger on
// a shared device.
export function clearCompletedIds(userId: string | null) {
  try {
    localStorage.removeItem(keyFor(userId));
    localStorage.removeItem(LS_KEY);
  } catch {}
}
