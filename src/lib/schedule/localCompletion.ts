// localStorage adapter for completion state — the offline fallback and
// first-paint cache behind ScheduleContext's completedIds.

const LS_KEY = 'apex-completed';

export function loadCompletedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function saveCompletedIds(ids: Set<string>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify([...ids])); } catch {}
}

// Called on sign-out: the cache is per-account state and must not leak to
// the next user on a shared device.
export function clearCompletedIds() {
  try { localStorage.removeItem(LS_KEY); } catch {}
}
