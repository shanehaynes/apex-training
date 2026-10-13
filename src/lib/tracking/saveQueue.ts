// The tracker's autosave queue, pure so it can be tested without a DOM:
// `useWorkoutSession` marks keys dirty and the queue decides what to send,
// when, and what counts as saved. The one promise it keeps is that a key
// stays dirty until a send that carried its current value resolves —
// clearing the dirty set before the request (what the hook used to do) is
// how one failed request silently dropped a logged set.
//
// Sends never overlap: the server runs each batch as idempotent upserts with
// no versioning, so a stale batch landing after a newer one would overwrite
// the newer values. Failures retry with exponential backoff, honouring the
// server's Retry-After on a 429.

export interface SaveQueueDeps {
  /** Send these keys now. Resolves on success; rejects on failure. A rejection may carry `{ retryAfterMs?: number }` (e.g. from a 429). */
  send: (keys: readonly string[]) => Promise<void>;
  setTimeout?: (fn: () => void, ms: number) => unknown;   // injectable for tests; default globalThis.setTimeout
  clearTimeout?: (handle: unknown) => void;                // default globalThis.clearTimeout
  backoff?: { baseMs: number; maxMs: number };             // default { baseMs: 1000, maxMs: 30000 }
  barAfterFailures?: number;                                // default 2
  onChange?: (state: SaveQueueState) => void;               // called after every state change
}

export interface SaveQueueState {
  pending: number;              // distinct keys still dirty
  inFlight: boolean;
  consecutiveFailures: number;
  showBar: boolean;             // consecutiveFailures >= barAfterFailures
  nextRetryAt: number | null;   // epoch ms of the scheduled retry, or null
}

export interface SaveQueue {
  markDirty(key: string): void;   // bumps the key's generation
  unmark(key: string): void;      // the hook dropped this key (e.g. a set removed before it was ever saved)
  flush(): Promise<boolean>;      // see A2, A5
  retryNow(): Promise<boolean>;   // cancels any scheduled retry, then flushes
  state(): SaveQueueState;
  dispose(): void;                // cancels timers; afterwards markDirty is ignored and flush resolves false without sending
}

const DEFAULT_BACKOFF = { baseMs: 1000, maxMs: 30000 };
const DEFAULT_BAR_AFTER_FAILURES = 2;

function retryAfterOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const value = (err as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function createSaveQueue(deps: SaveQueueDeps): SaveQueue {
  const setTimer = deps.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout ?? ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
  const backoff = deps.backoff ?? DEFAULT_BACKOFF;
  const barAfterFailures = deps.barAfterFailures ?? DEFAULT_BAR_AFTER_FAILURES;

  // Insertion order is first-dirtied order (A7): re-marking an existing key
  // keeps its slot. Generations come from one counter so a key unmarked and
  // re-marked mid-flight never collides with the in-flight snapshot (A1).
  const generations = new Map<string, number>();
  let nextGeneration = 1;

  let inFlight: Promise<boolean> | null = null;
  // The one follow-up send that any number of flush() calls made during a
  // send coalesce into (A2).
  let queued: Promise<boolean> | null = null;
  let consecutiveFailures = 0;
  let retryHandle: unknown = null;
  let nextRetryAt: number | null = null;
  let disposed = false;

  const state = (): SaveQueueState => ({
    pending: generations.size,
    inFlight: inFlight !== null,
    consecutiveFailures,
    showBar: consecutiveFailures >= barAfterFailures,
    nextRetryAt,
  });

  let lastEmitted = state();
  const emit = () => {
    const next = state();
    const changed = (Object.keys(next) as (keyof SaveQueueState)[]).some(k => next[k] !== lastEmitted[k]);
    if (!changed) return;
    lastEmitted = next;
    deps.onChange?.(next);
  };

  const cancelRetry = () => {
    if (retryHandle !== null) {
      clearTimer(retryHandle);
      retryHandle = null;
    }
    nextRetryAt = null;
  };

  const scheduleRetry = (err: unknown) => {
    cancelRetry();
    const exponential = Math.min(backoff.maxMs, backoff.baseMs * 2 ** (consecutiveFailures - 1));
    const delay = Math.max(exponential, retryAfterOf(err) ?? 0);
    nextRetryAt = Date.now() + delay;
    retryHandle = setTimer(() => {
      retryHandle = null;
      nextRetryAt = null;
      if (disposed || inFlight) return;
      if (generations.size > 0) send();
      else emit();
    }, delay);
  };

  // One send: snapshot the dirty keys with their generations, post them, and
  // on success forget only the keys nobody touched meanwhile (A1). Never
  // rejects — the boolean is the outcome.
  const send = (): Promise<boolean> => {
    cancelRetry();
    const snapshot = new Map(generations);
    const keys = [...snapshot.keys()];
    const run = (async () => {
      let ok: boolean;
      try {
        await deps.send(keys);
        for (const [key, generation] of snapshot) {
          if (generations.get(key) === generation) generations.delete(key);
        }
        consecutiveFailures = 0;
        ok = true;
      } catch (err) {
        consecutiveFailures += 1;
        ok = false;
        if (!disposed) scheduleRetry(err);
      }
      inFlight = null;
      emit();
      return ok;
    })();
    inFlight = run;
    emit();
    return run;
  };

  const flush = (): Promise<boolean> => {
    if (disposed) return Promise.resolve(false);
    if (inFlight) {
      // Wait for the running send. If it succeeded and keys were dirtied
      // after its snapshot, send once more; if it failed, resolve false and
      // leave the next attempt to the backoff timer (A2, A5, A8).
      queued ??= inFlight.then(ok => {
        queued = null;
        if (!ok || disposed) return false;
        return generations.size > 0 ? send() : true;
      });
      return queued;
    }
    if (generations.size === 0) {
      // Nothing to send is a successful flush: an armed retry has nothing
      // to retry either.
      cancelRetry();
      emit();
      return Promise.resolve(true);
    }
    return send();
  };

  return {
    markDirty(key) {
      if (disposed) return;
      generations.set(key, nextGeneration++);
      emit();
    },
    unmark(key) {
      if (!generations.delete(key)) return;
      emit();
    },
    flush,
    retryNow() {
      cancelRetry();
      emit();
      return flush();
    },
    state,
    dispose() {
      disposed = true;
      cancelRetry();
      emit();
    },
  };
}
