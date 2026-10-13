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
// server's Retry-After on a 429 and clamped to `maxRetryMs`. A 4xx other
// than 401/403/408/429 is the server refusing rows, not a transient fault:
// the batch is re-sent one key at a time so only the refused key leaves the
// queue as `rejected` (re-dirtying it re-queues it). A 401/403 pauses the
// queue — nothing retries until the user, signed in again, presses Retry.

export interface SaveQueueDeps {
  /** Send these keys now. Resolves on success; rejects on failure. A rejection may carry `{ retryAfterMs?: number }` (e.g. from a 429) and `{ status?: number }`. */
  send: (keys: readonly string[]) => Promise<void>;
  setTimeout?: (fn: () => void, ms: number) => unknown;   // injectable for tests; default globalThis.setTimeout
  clearTimeout?: (handle: unknown) => void;                // default globalThis.clearTimeout
  backoff?: { baseMs: number; maxMs: number };             // default { baseMs: 1000, maxMs: 30000 }
  /** Every scheduled delay, backoff or Retry-After, is clamped to this. Default 60000. */
  maxRetryMs?: number;
  barAfterFailures?: number;                                // default 2
  onChange?: (state: SaveQueueState) => void;               // called after every state change
}

export interface SaveQueueState {
  pending: number;              // distinct keys still dirty
  inFlight: boolean;
  consecutiveFailures: number;
  showBar: boolean;             // consecutiveFailures >= barAfterFailures || rejected > 0 || paused
  nextRetryAt: number | null;   // epoch ms of the scheduled retry, or null
  rejected: number;             // distinct keys the server refused (4xx); re-dirtying one re-queues it
  rejectedKeys: readonly string[]; // those keys, first-dirtied order; a snapshot per call
  paused: boolean;              // a 401/403 stopped the queue; retryNow() resumes it
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
export const DEFAULT_MAX_RETRY_MS = 60_000;

function retryAfterOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const value = (err as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function statusOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

/** A 401/403: the session is gone, so no row will land until the user signs in again. */
export function isAuthFailure(err: unknown): boolean {
  const status = statusOf(err);
  return status === 401 || status === 403;
}

/**
 * A rejection the server will keep giving for these rows: a numeric 4xx
 * status other than 401/403 (auth — pauses instead), 408 (timeout) and 429
 * (rate limit). Anything else — 5xx, a dead socket, a status given as a
 * string — is transient and retried.
 */
export function isNonRetryable(err: unknown): boolean {
  const status = statusOf(err);
  return status !== null && status >= 400 && status <= 499
    && status !== 401 && status !== 403 && status !== 408 && status !== 429;
}

function sameState(a: SaveQueueState, b: SaveQueueState): boolean {
  return a.pending === b.pending && a.inFlight === b.inFlight
    && a.consecutiveFailures === b.consecutiveFailures && a.showBar === b.showBar
    && a.nextRetryAt === b.nextRetryAt && a.rejected === b.rejected && a.paused === b.paused
    && a.rejectedKeys.length === b.rejectedKeys.length
    && a.rejectedKeys.every((k, i) => k === b.rejectedKeys[i]);
}

export function createSaveQueue(deps: SaveQueueDeps): SaveQueue {
  const setTimer = deps.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout ?? ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
  const backoff = deps.backoff ?? DEFAULT_BACKOFF;
  const maxRetryMs = deps.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
  const barAfterFailures = deps.barAfterFailures ?? DEFAULT_BAR_AFTER_FAILURES;

  // Insertion order is first-dirtied order (A7): re-marking an existing key
  // keeps its slot. Generations come from one counter so a key unmarked and
  // re-marked mid-flight never collides with the in-flight snapshot (A1).
  const generations = new Map<string, number>();
  let nextGeneration = 1;
  const rejected = new Set<string>();

  let inFlight: Promise<boolean> | null = null;
  // The one follow-up any number of flush() calls made during a send
  // coalesce into (A2).
  let queued: Promise<boolean> | null = null;
  let consecutiveFailures = 0;
  let retryHandle: unknown = null;
  let nextRetryAt: number | null = null;
  let paused = false;
  let disposed = false;

  const state = (): SaveQueueState => ({
    pending: generations.size,
    inFlight: inFlight !== null,
    consecutiveFailures,
    showBar: consecutiveFailures >= barAfterFailures || rejected.size > 0 || paused,
    nextRetryAt,
    rejected: rejected.size,
    rejectedKeys: [...rejected],
    paused,
  });

  let lastEmitted = state();
  const emit = () => {
    const next = state();
    if (sameState(next, lastEmitted)) return;
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
    const delay = Math.min(maxRetryMs, Math.max(exponential, retryAfterOf(err) ?? 0));
    nextRetryAt = Date.now() + delay;
    retryHandle = setTimer(() => {
      retryHandle = null;
      nextRetryAt = null;
      if (disposed || inFlight || paused) return;
      if (generations.size > 0) send();
      else emit();
    }, delay);
  };

  // A key leaves the dirty set only if nobody touched it since `generation`
  // was read (A1); a re-dirtied key keeps its newer generation and stays.
  const settleKey = (key: string, generation: number, refused: boolean) => {
    if (generations.get(key) !== generation) return;
    generations.delete(key);
    if (refused) rejected.add(key);
  };

  // The three ways a send can end badly, shared by the batch and the
  // single-key isolation sends. Each returns the flush outcome.
  const onPaused = (): boolean => {
    paused = true;
    cancelRetry();
    inFlight = null;
    emit();
    return false;
  };
  const onFailed = (err: unknown): boolean => {
    consecutiveFailures += 1;
    inFlight = null;
    if (!disposed) scheduleRetry(err);
    emit();
    return false;
  };
  const onDone = (): boolean => {
    consecutiveFailures = 0;
    inFlight = null;
    emit();
    return true;
  };

  // The server refused a batch, and it refuses a batch whole: re-send each
  // snapshot key alone, in order, so only the key it actually refuses is
  // rejected. One send is in flight throughout; a transient failure stops
  // the pass with the rest still pending, and an auth failure pauses it.
  const isolate = async (snapshot: Map<string, number>): Promise<boolean> => {
    for (const key of snapshot.keys()) {
      const generation = generations.get(key);
      if (generation === undefined) continue; // unmarked meanwhile
      try {
        await deps.send([key]);
        settleKey(key, generation, false);
        emit();
      } catch (err) {
        if (isAuthFailure(err)) return onPaused();
        if (!isNonRetryable(err)) return onFailed(err);
        settleKey(key, generation, true);
        emit();
      }
    }
    return onDone();
  };

  // One send: snapshot the dirty keys with their generations and post them.
  // `inFlight` is set before `send` is invoked, so a send that throws
  // synchronously is one ordinary failure. Never rejects — the boolean is
  // the outcome.
  const send = (): Promise<boolean> => {
    cancelRetry();
    const snapshot = new Map(generations);
    const keys = [...snapshot.keys()];
    const run = Promise.resolve()
      .then(() => deps.send(keys))
      .then(
        () => {
          for (const [key, generation] of snapshot) settleKey(key, generation, false);
          return onDone();
        },
        (err: unknown) => {
          if (isAuthFailure(err)) return onPaused();
          if (!isNonRetryable(err)) return onFailed(err);
          if (snapshot.size > 1) return isolate(snapshot);
          // A one-key refusal is its own transition (the streak count
          // untouched); the flush then counts as successful (A10, A12).
          for (const [key, generation] of snapshot) settleKey(key, generation, true);
          cancelRetry();
          inFlight = null;
          emit();
          return onDone();
        },
      );
    inFlight = run;
    emit();
    return run;
  };

  // A flush with nothing to send is a successful flush (A12): the failure
  // streak is over and an armed retry has nothing to retry.
  const flushEmpty = (): Promise<boolean> => {
    cancelRetry();
    consecutiveFailures = 0;
    emit();
    return Promise.resolve(true);
  };

  // What a flush that waited on a send does once it settles: a failure is
  // the backoff timer's to retry; a success sends again only if keys are
  // pending — joining a send another caller started meanwhile (A13).
  const afterSend = (ok: boolean): Promise<boolean> => {
    if (disposed || !ok) return Promise.resolve(false);
    if (inFlight) return flush();
    return generations.size > 0 ? send() : flushEmpty();
  };

  const flush = (): Promise<boolean> => {
    if (disposed) return Promise.resolve(false);
    if (inFlight) {
      queued ??= inFlight.then(ok => {
        queued = null;
        return afterSend(ok);
      });
      return queued;
    }
    if (paused) return Promise.resolve(false);
    return generations.size > 0 ? send() : flushEmpty();
  };

  return {
    markDirty(key) {
      if (disposed) return;
      rejected.delete(key);
      generations.set(key, nextGeneration++);
      emit();
    },
    unmark(key) {
      const wasRejected = rejected.delete(key);
      const wasPending = generations.delete(key);
      if (wasRejected || wasPending) emit();
    },
    flush,
    retryNow() {
      if (!disposed) paused = false;
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
