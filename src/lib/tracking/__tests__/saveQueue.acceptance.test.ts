// Acceptance tests for the tracker save queue, written from the spec alone
// (A1–A9 plus unmark/dispose) against an implementation this file never saw.
// Timers are injected through the `setTimeout`/`clearTimeout` deps and `send`
// is a hand-settled promise, so no case ever waits on real time; every case
// carries a timeout so a hanging implementation reports FAIL, not a stuck run.
// Cases whose name starts with `AMBIGUOUS:` assume something the spec does
// not say; each is listed under SPEC GAPS in the lane report.
import { describe, it, expect, vi } from 'vitest';
import { createSaveQueue } from '../saveQueue';
import type { SaveQueue, SaveQueueDeps, SaveQueueState } from '../saveQueue';

const CASE = { timeout: 1000 };

/** Small, fast backoff for most cases: 100, 200, 350, 350, ... */
const BACKOFF = { baseMs: 100, maxMs: 350 };

const INITIAL: SaveQueueState = {
  pending: 0,
  inFlight: false,
  consecutiveFailures: 0,
  showBar: false,
  nextRetryAt: null,
  rejected: 0,
};

/** A rejection carrying an HTTP status, as a fetch wrapper would throw it. */
const httpError = (status: number, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error(`HTTP ${status}`), { status, ...extra });

/** Drain the microtask queue a few turns deep, then one macrotask. Never real time. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/** A manual clock handed to the queue through the injectable timer deps. */
class FakeTimers {
  now = 0;
  /** Every `ms` ever passed to setTimeout, in order. */
  readonly delays: number[] = [];
  /** Every handle ever passed to clearTimeout, in order. */
  readonly cleared: unknown[] = [];
  private seq = 0;
  private readonly timers = new Map<number, Timer>();

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.delays.push(ms);
    this.timers.set(id, { id, at: this.now + ms, fn });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.cleared.push(handle);
    if (typeof handle === 'number') this.timers.delete(handle);
  };

  pending(): number {
    return this.timers.size;
  }

  lastDelay(): number | undefined {
    return this.delays[this.delays.length - 1];
  }

  /** Move the clock forward, firing due timers in order and settling after each. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.values()]
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id);
      const next = due[0];
      if (!next) break;
      this.timers.delete(next.id);
      this.now = Math.max(this.now, next.at);
      next.fn();
      await settle();
    }
    this.now = target;
  }
}

interface Attempt {
  /** Copy of the keys `send` received, taken at call time. */
  keys: string[];
  settled: boolean;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

interface HarnessOptions {
  /** 'default' omits the dep so the module's own default applies. */
  backoff?: { baseMs: number; maxMs: number } | 'default';
  barAfterFailures?: number;
  maxRetryMs?: number;
  /** How many leading `send` calls throw synchronously instead of returning a promise. */
  throwSyncFirst?: number;
}

function makeHarness(options: HarnessOptions = {}) {
  const timers = new FakeTimers();
  const attempts: Attempt[] = [];
  /** Cloned `onChange` payloads, in order. */
  const states: SaveQueueState[] = [];
  /** The raw object each `onChange` call received (reference, not a clone). */
  const stateRefs: SaveQueueState[] = [];
  /** Times `onChange` reported something other than `state()` at that moment. */
  let mismatches = 0;
  let open = 0;
  let maxConcurrent = 0;
  let throwSync = options.throwSyncFirst ?? 0;

  const send = vi.fn((keys: readonly string[]): Promise<void> => {
    if (throwSync > 0) {
      throwSync -= 1;
      throw new Error('send threw synchronously');
    }
    open += 1;
    maxConcurrent = Math.max(maxConcurrent, open);
    return new Promise<void>((resolve, reject) => {
      const attempt: Attempt = {
        keys: [...keys],
        settled: false,
        resolve: () => {
          if (attempt.settled) return;
          attempt.settled = true;
          open -= 1;
          resolve();
        },
        reject: (reason) => {
          if (attempt.settled) return;
          attempt.settled = true;
          open -= 1;
          reject(reason);
        },
      };
      attempts.push(attempt);
    });
  });

  let queue: SaveQueue | undefined;
  const deps: SaveQueueDeps = {
    send,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onChange: (state) => {
      stateRefs.push(state);
      states.push({ ...state });
      if (queue && JSON.stringify(state) !== JSON.stringify(queue.state())) mismatches += 1;
    },
  };
  if (options.backoff !== 'default') deps.backoff = options.backoff ?? BACKOFF;
  if (options.barAfterFailures !== undefined) deps.barAfterFailures = options.barAfterFailures;
  if (options.maxRetryMs !== undefined) deps.maxRetryMs = options.maxRetryMs;
  queue = createSaveQueue(deps);

  const attempt = (index: number): Attempt => {
    const found = attempts[index];
    if (!found) throw new Error(`send call #${index} never happened (${attempts.length} call(s) so far)`);
    return found;
  };
  const succeed = async (index = attempts.length - 1): Promise<void> => {
    attempt(index).resolve();
    await settle();
  };
  const fail = async (reason: unknown = new Error('save failed'), index = attempts.length - 1): Promise<void> => {
    attempt(index).reject(reason);
    await settle();
  };
  const sentKeys = (): string[][] => attempts.map((a) => a.keys);
  const lastState = (): SaveQueueState | undefined => states[states.length - 1];

  return {
    queue,
    send,
    timers,
    attempts,
    states,
    stateRefs,
    mismatches: () => mismatches,
    maxConcurrent: () => maxConcurrent,
    attempt,
    succeed,
    fail,
    sentKeys,
    lastState,
  };
}

describe('saveQueue acceptance', () => {
  describe('A5 — nothing pending', () => {
    it('flush() with nothing pending resolves true without calling send', CASE, async () => {
      const h = makeHarness();
      await expect(h.queue.flush()).resolves.toBe(true);
      expect(h.send).not.toHaveBeenCalled();
      expect(h.queue.state()).toEqual(INITIAL);
    });

    it('retryNow() with nothing pending resolves true without calling send', CASE, async () => {
      const h = makeHarness();
      await expect(h.queue.retryNow()).resolves.toBe(true);
      expect(h.send).not.toHaveBeenCalled();
    });
  });

  describe('A7 — key order', () => {
    it('send receives distinct keys in first-dirtied order after interleaved marks', CASE, async () => {
      const h = makeHarness();
      for (const key of ['b', 'a', 'b', 'c', 'a']) h.queue.markDirty(key);
      expect(h.queue.state().pending).toBe(3);
      const flushed = h.queue.flush();
      await settle();
      expect(h.attempt(0).keys).toEqual(['b', 'a', 'c']);
      await h.succeed();
      await expect(flushed).resolves.toBe(true);
      expect(h.send).toHaveBeenCalledTimes(1);
    });

    it('a key sent, then dirtied again after others, takes its new first-dirtied position', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const first = h.queue.flush();
      await settle();
      await h.succeed();
      await expect(first).resolves.toBe(true);
      h.queue.markDirty('b');
      h.queue.markDirty('a');
      const second = h.queue.flush();
      await settle();
      expect(h.attempt(1).keys).toEqual(['b', 'a']);
      await h.succeed();
      await expect(second).resolves.toBe(true);
    });
  });

  describe('A1 — generations', () => {
    it('a successful flush removes the sent keys and resolves true', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      h.queue.markDirty('b');
      const flushed = h.queue.flush();
      await settle();
      expect(h.queue.state().inFlight).toBe(true);
      await h.succeed();
      await expect(flushed).resolves.toBe(true);
      expect(h.queue.state()).toEqual(INITIAL);
      // Nothing left: a second flush sends nothing.
      await expect(h.queue.flush()).resolves.toBe(true);
      expect(h.send).toHaveBeenCalledTimes(1);
    });

    it('a key re-dirtied while its send is in flight stays pending and goes in the next send', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      h.queue.markDirty('b');
      const first = h.queue.flush();
      await settle();
      expect(h.attempt(0).keys).toEqual(['a', 'b']);
      h.queue.markDirty('a'); // in flight: a new generation of `a`
      await h.succeed(0);
      await expect(first).resolves.toBe(true);
      expect(h.queue.state().pending).toBe(1);
      const second = h.queue.flush();
      await settle();
      // Whichever send carries it, the re-dirtied key goes out again, alone.
      const last = h.attempts[h.attempts.length - 1];
      expect(last.keys).toEqual(['a']);
      await h.succeed();
      await expect(second).resolves.toBe(true);
      expect(h.queue.state().pending).toBe(0);
    });

    it("a new key dirtied during an in-flight send survives that send's success", CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const first = h.queue.flush();
      await settle();
      h.queue.markDirty('c'); // not in the snapshot
      await h.succeed(0);
      await expect(first).resolves.toBe(true);
      expect(h.queue.state().pending).toBe(1);
      const second = h.queue.flush();
      await settle();
      const last = h.attempts[h.attempts.length - 1];
      expect(last.keys).toEqual(['c']);
      await h.succeed();
      await expect(second).resolves.toBe(true);
      expect(h.queue.state().pending).toBe(0);
    });
  });

  describe('A2 — one send at a time', () => {
    it('a second flush() during a send waits, then sends the newly pending keys exactly once', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const p1 = h.queue.flush();
      await settle();
      expect(h.send).toHaveBeenCalledTimes(1);
      h.queue.markDirty('b');
      const p2 = h.queue.flush();
      const p3 = h.queue.flush(); // coalesces with p2
      await settle();
      expect(h.send).toHaveBeenCalledTimes(1); // still only the first send
      await h.succeed(0);
      await expect(p1).resolves.toBe(true);
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.attempt(1).keys).toEqual(['b']);
      await h.succeed(1);
      await expect(p2).resolves.toBe(true);
      await expect(p3).resolves.toBe(true);
      await settle();
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.maxConcurrent()).toBe(1);
      expect(h.queue.state().pending).toBe(0);
    });

    it('flush() during a send with nothing newly pending sends nothing more and resolves true', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const p1 = h.queue.flush();
      await settle();
      const p2 = h.queue.flush();
      await settle();
      expect(h.send).toHaveBeenCalledTimes(1);
      await h.succeed(0);
      await expect(p1).resolves.toBe(true);
      await expect(p2).resolves.toBe(true);
      expect(h.send).toHaveBeenCalledTimes(1);
    });

    it('flush() during a send resolves false when the later send it waited on fails', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const p1 = h.queue.flush();
      await settle();
      h.queue.markDirty('b');
      const p2 = h.queue.flush();
      await settle();
      await h.succeed(0);
      await expect(p1).resolves.toBe(true);
      expect(h.attempt(1).keys).toEqual(['b']);
      await h.fail(new Error('boom'), 1);
      await expect(p2).resolves.toBe(false);
      expect(h.queue.state().pending).toBe(1);
      expect(h.queue.state().consecutiveFailures).toBe(1);
      expect(h.maxConcurrent()).toBe(1);
    });

    it('a retry timer firing during an in-flight send does not start a second send', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const p1 = h.queue.flush();
      await settle();
      await h.fail();
      await expect(p1).resolves.toBe(false);
      expect(h.timers.pending()).toBe(1);
      h.queue.markDirty('b');
      const p2 = h.queue.flush(); // manual send while the retry is still scheduled
      await settle();
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.attempt(1).keys).toEqual(['a', 'b']);
      await h.timers.advance(BACKOFF.baseMs); // the timer fires mid-send
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.maxConcurrent()).toBe(1);
      await h.succeed(1);
      await expect(p2).resolves.toBe(true);
      expect(h.maxConcurrent()).toBe(1);
      expect(h.queue.state().pending).toBe(0);
    });
  });

  describe('A3 — failure and backoff', () => {
    it('a failed send keeps the keys pending, resolves false, and schedules a retry after baseMs', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await h.fail();
      await expect(flushed).resolves.toBe(false);
      const state = h.queue.state();
      expect(state.pending).toBe(1);
      expect(state.inFlight).toBe(false);
      expect(state.consecutiveFailures).toBe(1);
      expect(h.timers.pending()).toBe(1);
      expect(h.timers.lastDelay()).toBe(BACKOFF.baseMs);
      // Not yet due.
      await h.timers.advance(BACKOFF.baseMs - 1);
      expect(h.send).toHaveBeenCalledTimes(1);
      await h.timers.advance(1);
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.attempt(1).keys).toEqual(['a']);
    });

    it('backoff doubles per consecutive failure and caps at maxMs', CASE, async () => {
      const h = makeHarness({ backoff: { baseMs: 100, maxMs: 350 } });
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await h.fail();
      await expect(flushed).resolves.toBe(false);
      const expected = [100, 200, 350, 350];
      for (let i = 0; i < expected.length; i++) {
        expect(h.queue.state().consecutiveFailures).toBe(i + 1);
        expect(h.timers.lastDelay()).toBe(expected[i]);
        await h.timers.advance(expected[i]);
        expect(h.send).toHaveBeenCalledTimes(i + 2);
        await h.fail();
      }
      expect(h.queue.state().consecutiveFailures).toBe(5);
      expect(h.timers.delays).toEqual([100, 200, 350, 350, 350]);
    });

    it('the default backoff is 1000ms doubling to a 30000ms cap', CASE, async () => {
      const h = makeHarness({ backoff: 'default' });
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await h.fail();
      await expect(flushed).resolves.toBe(false);
      const expected = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
      for (let i = 0; i < expected.length; i++) {
        expect(h.timers.lastDelay()).toBe(expected[i]);
        await h.timers.advance(expected[i]);
        await h.fail();
      }
      expect(h.timers.delays).toEqual([...expected, 30000]);
    });

    it('retryAfterMs larger than the backoff wins (plain rejection object)', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await h.fail({ retryAfterMs: 5000 });
      await expect(flushed).resolves.toBe(false);
      expect(h.timers.lastDelay()).toBe(5000);
      await h.timers.advance(4999);
      expect(h.send).toHaveBeenCalledTimes(1);
      await h.timers.advance(1);
      expect(h.send).toHaveBeenCalledTimes(2);
      // The failure still counted: the next plain failure uses the doubled backoff.
      await h.fail();
      expect(h.queue.state().consecutiveFailures).toBe(2);
      expect(h.timers.lastDelay()).toBe(200);
    });

    it('retryAfterMs smaller than the backoff is ignored (Error carrying the field)', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await h.fail();
      await expect(flushed).resolves.toBe(false);
      await h.timers.advance(100);
      await h.fail(Object.assign(new Error('slow down'), { retryAfterMs: 10 }));
      expect(h.queue.state().consecutiveFailures).toBe(2);
      expect(h.timers.lastDelay()).toBe(200);
      await h.timers.advance(200);
      expect(h.send).toHaveBeenCalledTimes(3);
      await h.fail(Object.assign(new Error('slow down'), { retryAfterMs: 5000 }));
      expect(h.timers.lastDelay()).toBe(5000);
    });

    it('retries continue through consecutive failures until a success clears everything', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await h.fail();
      await expect(flushed).resolves.toBe(false);
      await h.timers.advance(100);
      await h.fail(); // a failed retry is itself retried
      await h.timers.advance(200);
      await h.fail();
      expect(h.queue.state().consecutiveFailures).toBe(3);
      await h.timers.advance(350);
      expect(h.send).toHaveBeenCalledTimes(4);
      expect(h.attempt(3).keys).toEqual(['a']);
      await h.succeed();
      expect(h.queue.state()).toEqual(INITIAL);
      expect(h.timers.pending()).toBe(0);
      await h.timers.advance(60000);
      expect(h.send).toHaveBeenCalledTimes(4);
    });

    it('nextRetryAt is null until a failure, a number while a retry is scheduled, null after success', CASE, async () => {
      const h = makeHarness();
      expect(h.queue.state().nextRetryAt).toBeNull();
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      expect(h.queue.state().nextRetryAt).toBeNull();
      await h.fail();
      await expect(flushed).resolves.toBe(false);
      expect(typeof h.queue.state().nextRetryAt).toBe('number');
      await h.timers.advance(100);
      await h.succeed();
      expect(h.queue.state().nextRetryAt).toBeNull();
    });
  });

  describe('A4 — showBar', () => {
    it('showBar appears at the default two failures and a success resets it', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await h.fail();
      await expect(flushed).resolves.toBe(false);
      expect(h.queue.state().consecutiveFailures).toBe(1);
      expect(h.queue.state().showBar).toBe(false);
      await h.timers.advance(100);
      await h.fail();
      expect(h.queue.state().consecutiveFailures).toBe(2);
      expect(h.queue.state().showBar).toBe(true);
      await h.timers.advance(200);
      await h.succeed();
      expect(h.queue.state().consecutiveFailures).toBe(0);
      expect(h.queue.state().showBar).toBe(false);
      expect(h.queue.state().pending).toBe(0);
    });

    it('barAfterFailures is configurable', CASE, async () => {
      const one = makeHarness({ barAfterFailures: 1 });
      one.queue.markDirty('a');
      const flushedOne = one.queue.flush();
      await settle();
      await one.fail();
      await expect(flushedOne).resolves.toBe(false);
      expect(one.queue.state().showBar).toBe(true);

      const three = makeHarness({ barAfterFailures: 3 });
      three.queue.markDirty('a');
      const flushedThree = three.queue.flush();
      await settle();
      await three.fail();
      await expect(flushedThree).resolves.toBe(false);
      await three.timers.advance(100);
      await three.fail();
      expect(three.queue.state().consecutiveFailures).toBe(2);
      expect(three.queue.state().showBar).toBe(false);
      await three.timers.advance(200);
      await three.fail();
      expect(three.queue.state().showBar).toBe(true);
    });
  });

  describe('A6 — retryNow', () => {
    it('retryNow() during a scheduled retry cancels the timer and sends once', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await h.fail();
      await expect(flushed).resolves.toBe(false);
      expect(h.timers.pending()).toBe(1);
      const retried = h.queue.retryNow();
      await settle();
      expect(h.timers.pending()).toBe(0);
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.attempt(1).keys).toEqual(['a']);
      await h.succeed(1);
      await expect(retried).resolves.toBe(true);
      expect(h.queue.state()).toEqual(INITIAL);
      await h.timers.advance(60000); // the cancelled retry never fires
      expect(h.send).toHaveBeenCalledTimes(2);
    });

    it('retryNow() during an in-flight send waits for it like flush()', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const p1 = h.queue.flush();
      await settle();
      h.queue.markDirty('b');
      const p2 = h.queue.retryNow();
      await settle();
      expect(h.send).toHaveBeenCalledTimes(1);
      await h.succeed(0);
      await expect(p1).resolves.toBe(true);
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.attempt(1).keys).toEqual(['b']);
      await h.succeed(1);
      await expect(p2).resolves.toBe(true);
      expect(h.maxConcurrent()).toBe(1);
    });
  });

  describe('A8 — dirtied during a failed send', () => {
    it('keys dirtied during a failed send are included in the retry, in order', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      h.queue.markDirty('b');
      h.queue.markDirty('a'); // re-dirtied in flight, keeps its original position
      await h.fail();
      await expect(flushed).resolves.toBe(false);
      expect(h.queue.state().pending).toBe(2);
      await h.timers.advance(100);
      expect(h.attempt(1).keys).toEqual(['a', 'b']);
      await h.succeed();
      expect(h.queue.state().pending).toBe(0);
    });
  });

  describe('A9 — state() and onChange', () => {
    it('state() tracks marks, re-marks, unmarks and the send lifecycle', CASE, async () => {
      const h = makeHarness();
      expect(h.queue.state()).toEqual(INITIAL);
      h.queue.markDirty('a');
      expect(h.queue.state().pending).toBe(1);
      h.queue.markDirty('a');
      expect(h.queue.state().pending).toBe(1);
      h.queue.markDirty('b');
      expect(h.queue.state().pending).toBe(2);
      h.queue.unmark('a');
      expect(h.queue.state().pending).toBe(1);
      const flushed = h.queue.flush();
      await settle();
      expect(h.queue.state()).toEqual({ ...INITIAL, pending: 1, inFlight: true });
      await h.succeed();
      await expect(flushed).resolves.toBe(true);
      expect(h.queue.state()).toEqual(INITIAL);
    });

    it('onChange fires after every transition with the new state', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      expect(h.lastState()).toEqual({ ...INITIAL, pending: 1 });
      const flushed = h.queue.flush();
      await settle();
      expect(h.lastState()).toEqual({ ...INITIAL, pending: 1, inFlight: true });
      await h.fail();
      await expect(flushed).resolves.toBe(false);
      const failed = h.lastState();
      expect(failed).toMatchObject({ pending: 1, inFlight: false, consecutiveFailures: 1 });
      expect(typeof failed?.nextRetryAt).toBe('number');
      await h.timers.advance(100);
      expect(h.lastState()).toMatchObject({ pending: 1, inFlight: true });
      await h.succeed();
      expect(h.lastState()).toEqual(INITIAL);
      h.queue.markDirty('z');
      h.queue.unmark('z');
      expect(h.lastState()).toEqual(INITIAL);
      expect(h.states.length).toBeGreaterThanOrEqual(7);
      expect(h.mismatches()).toBe(0);
    });
  });

  describe('unmark', () => {
    it('unmark removes a pending key without sending it; an unknown key is a no-op', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      h.queue.markDirty('b');
      h.queue.unmark('a');
      h.queue.unmark('never-marked');
      expect(h.queue.state().pending).toBe(1);
      const flushed = h.queue.flush();
      await settle();
      expect(h.attempt(0).keys).toEqual(['b']);
      await h.succeed();
      await expect(flushed).resolves.toBe(true);
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(h.queue.state().pending).toBe(0);
    });

    it('a key unmarked during a failed send is left out of the retry', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      h.queue.markDirty('b');
      const flushed = h.queue.flush();
      await settle();
      h.queue.unmark('b');
      await h.fail();
      await expect(flushed).resolves.toBe(false);
      expect(h.queue.state().pending).toBe(1);
      await h.timers.advance(100);
      expect(h.attempt(1).keys).toEqual(['a']);
      await h.succeed();
      expect(h.queue.state().pending).toBe(0);
    });
  });

  describe('dispose', () => {
    it('after dispose(), markDirty is ignored and flush() resolves false without sending', CASE, async () => {
      const h = makeHarness();
      h.queue.dispose();
      h.queue.markDirty('a');
      expect(h.queue.state().pending).toBe(0);
      await expect(h.queue.flush()).resolves.toBe(false);
      await expect(h.queue.retryNow()).resolves.toBe(false);
      expect(h.send).not.toHaveBeenCalled();
    });

    it('flush() after dispose() resolves false without sending keys that were already pending', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      h.queue.dispose();
      await expect(h.queue.flush()).resolves.toBe(false);
      expect(h.send).not.toHaveBeenCalled();
    });

    it('dispose() stops a scheduled retry from sending', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await h.fail();
      await expect(flushed).resolves.toBe(false);
      expect(h.timers.pending()).toBe(1);
      h.queue.dispose();
      await h.timers.advance(60000);
      expect(h.send).toHaveBeenCalledTimes(1);
    });

    it('dispose() during an in-flight send that then fails schedules no retry', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      void h.queue.flush();
      await settle();
      expect(h.send).toHaveBeenCalledTimes(1);
      h.queue.dispose();
      await h.fail();
      await h.timers.advance(60000);
      expect(h.send).toHaveBeenCalledTimes(1);
      h.queue.markDirty('b');
      await expect(h.queue.flush()).resolves.toBe(false);
      expect(h.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('A10 — non-retryable rejection', () => {
    it('a 4xx rejection schedules no retry: the snapshot keys leave pending and count as rejected', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      h.queue.markDirty('b');
      const flushed = h.queue.flush();
      await settle();
      await h.fail(httpError(422));
      await expect(flushed).resolves.toBe(true);
      expect(h.queue.state()).toEqual({ ...INITIAL, rejected: 2, showBar: true });
      expect(h.timers.pending()).toBe(0);
      await h.timers.advance(120000);
      expect(h.send).toHaveBeenCalledTimes(1);
      // Nothing pending: a later flush sends nothing and leaves the rejects alone.
      await expect(h.queue.flush()).resolves.toBe(true);
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(h.queue.state().rejected).toBe(2);
    });

    it('400 and 499 are non-retryable; 399, 408, 429 and 500 retry as before', CASE, async () => {
      for (const status of [400, 499]) {
        const h = makeHarness();
        h.queue.markDirty('a');
        const flushed = h.queue.flush();
        await settle();
        await h.fail(httpError(status));
        await expect(flushed).resolves.toBe(true);
        expect(h.queue.state()).toMatchObject({ pending: 0, rejected: 1, consecutiveFailures: 0, nextRetryAt: null });
        expect(h.timers.pending()).toBe(0);
      }
      for (const status of [399, 408, 429, 500]) {
        const h = makeHarness();
        h.queue.markDirty('a');
        const flushed = h.queue.flush();
        await settle();
        await h.fail(httpError(status));
        await expect(flushed).resolves.toBe(false);
        expect(h.queue.state()).toMatchObject({ pending: 1, rejected: 0, consecutiveFailures: 1 });
        expect(h.timers.pending()).toBe(1);
        await h.timers.advance(BACKOFF.baseMs);
        expect(h.attempt(1).keys).toEqual(['a']);
      }
    });

    it('markDirty of a rejected key makes it pending again, and onChange reports both transitions', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await h.fail(httpError(400));
      await expect(flushed).resolves.toBe(true);
      expect(h.queue.state().rejected).toBe(1);
      expect(h.lastState()).toMatchObject({ pending: 0, rejected: 1, showBar: true });
      h.queue.markDirty('a');
      expect(h.queue.state()).toEqual({ ...INITIAL, pending: 1 });
      expect(h.lastState()).toEqual({ ...INITIAL, pending: 1 });
      const again = h.queue.flush();
      await settle();
      expect(h.attempt(1).keys).toEqual(['a']);
      await h.succeed();
      await expect(again).resolves.toBe(true);
      expect(h.queue.state()).toEqual(INITIAL);
      expect(h.mismatches()).toBe(0);
    });

    it('a 4xx on a retry leaves consecutiveFailures un-incremented and arms no further retry', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await h.fail();
      await expect(flushed).resolves.toBe(false);
      expect(h.queue.state().consecutiveFailures).toBe(1);
      const retried = h.queue.retryNow();
      await settle();
      await h.fail(httpError(403));
      await expect(retried).resolves.toBe(true);
      const atRejection = h.states.find((st) => st.rejected === 1);
      expect(atRejection).toBeDefined();
      expect(atRejection?.consecutiveFailures).toBeLessThan(2); // the 4xx path never increments
      expect(h.queue.state()).toMatchObject({ pending: 0, rejected: 1, nextRetryAt: null, showBar: true });
      expect(h.timers.pending()).toBe(0);
      await h.timers.advance(120000);
      expect(h.send).toHaveBeenCalledTimes(2);
    });

    it('a 4xx rejects only the snapshot: a key dirtied during that send stays pending and a waiting flush sends it', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const p1 = h.queue.flush();
      await settle();
      h.queue.markDirty('b');
      const p2 = h.queue.flush();
      await settle();
      await h.fail(httpError(404), 0);
      expect(typeof (await p1)).toBe('boolean');
      expect(h.queue.state()).toMatchObject({ pending: 1, rejected: 1 });
      expect(h.attempt(1).keys).toEqual(['b']);
      await h.succeed(1);
      await expect(p2).resolves.toBe(true);
      expect(h.queue.state()).toEqual({ ...INITIAL, rejected: 1, showBar: true });
      expect(h.maxConcurrent()).toBe(1);
    });
  });

  describe('A11 — delay clamp', () => {
    it('retryAfterMs beyond an explicit maxRetryMs waits exactly the clamp', CASE, async () => {
      const h = makeHarness({ maxRetryMs: 2000 });
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await h.fail({ retryAfterMs: 9999 });
      await expect(flushed).resolves.toBe(false);
      expect(h.timers.lastDelay()).toBe(2000);
      expect(h.queue.state().nextRetryAt).not.toBeNull();
      await h.timers.advance(1999);
      expect(h.send).toHaveBeenCalledTimes(1);
      await h.timers.advance(1);
      expect(h.send).toHaveBeenCalledTimes(2);
    });

    it('backoff beyond an explicit maxRetryMs is clamped too', CASE, async () => {
      const h = makeHarness({ backoff: { baseMs: 1000, maxMs: 30000 }, maxRetryMs: 2500 });
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await h.fail();
      await expect(flushed).resolves.toBe(false);
      const expected = [1000, 2000, 2500, 2500];
      for (let i = 0; i < expected.length; i++) {
        expect(h.timers.lastDelay()).toBe(expected[i]);
        await h.timers.advance(expected[i]);
        await h.fail();
      }
      expect(h.timers.delays).toEqual([...expected, 2500]);
    });

    it('the default maxRetryMs is 60000', CASE, async () => {
      const h = makeHarness({ backoff: 'default' });
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await h.fail({ retryAfterMs: 100000 });
      await expect(flushed).resolves.toBe(false);
      expect(h.timers.lastDelay()).toBe(60000);
      await h.timers.advance(60000);
      await h.fail({ retryAfterMs: 59999 }); // under the clamp, above the 2000ms backoff: honoured as is
      expect(h.timers.lastDelay()).toBe(59999);
    });

    it('a non-finite or negative retryAfterMs is ignored and the backoff applies', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await h.fail({ retryAfterMs: Number.POSITIVE_INFINITY });
      await expect(flushed).resolves.toBe(false);
      expect(h.timers.lastDelay()).toBe(100);
      await h.timers.advance(100);
      await h.fail({ retryAfterMs: Number.NaN });
      expect(h.timers.lastDelay()).toBe(200);
      await h.timers.advance(200);
      await h.fail({ retryAfterMs: -5 });
      expect(h.timers.lastDelay()).toBe(350);
      expect(h.timers.delays.every((ms) => Number.isFinite(ms))).toBe(true);
    });
  });

  describe('A12 — a true flush resets the failure count', () => {
    it('flush() with nothing pending resolves true and resets consecutiveFailures and the bar', CASE, async () => {
      const h = makeHarness({ barAfterFailures: 1 });
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await h.fail();
      await expect(flushed).resolves.toBe(false);
      expect(h.queue.state()).toMatchObject({ consecutiveFailures: 1, showBar: true });
      h.queue.unmark('a');
      await expect(h.queue.flush()).resolves.toBe(true);
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(h.queue.state()).toMatchObject({ pending: 0, consecutiveFailures: 0, showBar: false });
    });

    it('a true flush leaves showBar up while rejected > 0', CASE, async () => {
      const h = makeHarness({ barAfterFailures: 1 });
      h.queue.markDirty('a');
      const first = h.queue.flush();
      await settle();
      await h.fail(httpError(400));
      await expect(first).resolves.toBe(true);
      h.queue.markDirty('b');
      const second = h.queue.flush();
      await settle();
      await h.fail(); // one retryable failure: bar is up on both counts
      await expect(second).resolves.toBe(false);
      expect(h.queue.state()).toMatchObject({ consecutiveFailures: 1, rejected: 1, showBar: true });
      const third = h.queue.retryNow();
      await settle();
      await h.succeed();
      await expect(third).resolves.toBe(true);
      expect(h.queue.state()).toEqual({ ...INITIAL, rejected: 1, showBar: true });
    });
  });

  describe('A13 — serialisation under re-entrancy', () => {
    it('a flush chained off the first flush and a flush during the send produce exactly one follow-up send', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const p1 = h.queue.flush();
      const p3 = p1.then(() => h.queue.flush());
      h.queue.markDirty('b');
      const p2 = h.queue.flush();
      await settle();
      expect(h.send).toHaveBeenCalledTimes(1);
      await h.succeed(0);
      await expect(p1).resolves.toBe(true);
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.attempt(1).keys).toEqual(['b']);
      expect(h.maxConcurrent()).toBe(1);
      await h.succeed(1);
      await expect(p2).resolves.toBe(true);
      await expect(p3).resolves.toBe(true);
      await settle();
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.maxConcurrent()).toBe(1);
      expect(h.queue.state()).toEqual(INITIAL);
    });

    it('a send that throws synchronously counts as one failure and is retried', CASE, async () => {
      const h = makeHarness({ throwSyncFirst: 1 });
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await expect(flushed).resolves.toBe(false);
      expect(h.queue.state()).toMatchObject({ pending: 1, inFlight: false, consecutiveFailures: 1 });
      expect(h.timers.pending()).toBe(1);
      expect(h.timers.lastDelay()).toBe(BACKOFF.baseMs);
      await h.timers.advance(BACKOFF.baseMs);
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.attempt(0).keys).toEqual(['a']); // the retry is the first call that returned a promise
      await h.succeed(0);
      expect(h.queue.state()).toEqual(INITIAL);
      // And a later flush still reaches send.
      h.queue.markDirty('c');
      const later = h.queue.flush();
      await settle();
      expect(h.attempt(1).keys).toEqual(['c']);
      await h.succeed(1);
      await expect(later).resolves.toBe(true);
    });
  });

  describe('spec gaps (ruled before they count)', () => {
    it('AMBIGUOUS: the flush whose own send was rejected 4xx resolves true even though a key dirtied in flight is still pending', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const p1 = h.queue.flush();
      await settle();
      h.queue.markDirty('b');
      await h.fail(httpError(404), 0);
      await expect(p1).resolves.toBe(true);
      expect(h.queue.state()).toMatchObject({ pending: 1, rejected: 1 });
    });

    it('AMBIGUOUS: a rejected 4xx error with a status given as a numeric string is not treated as non-retryable', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await h.fail(Object.assign(new Error('odd'), { status: '404' }));
      await expect(flushed).resolves.toBe(false);
      expect(h.queue.state()).toMatchObject({ pending: 1, rejected: 0, consecutiveFailures: 1 });
    });

    it('AMBIGUOUS: nextRetryAt is Date.now() + the clamped delay', CASE, async () => {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      try {
        const h = makeHarness({ maxRetryMs: 2000 });
        h.queue.markDirty('a');
        const flushed = h.queue.flush();
        await settle();
        await h.fail({ retryAfterMs: 9999 });
        await expect(flushed).resolves.toBe(false);
        expect(h.queue.state().nextRetryAt).toBe(1_700_000_000_000 + 2000);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('AMBIGUOUS: the onChange transition that first reports a rejection shows consecutiveFailures unchanged; the A12 reset is a later transition', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await h.fail();
      await expect(flushed).resolves.toBe(false);
      const retried = h.queue.retryNow();
      await settle();
      await h.fail(httpError(403));
      await expect(retried).resolves.toBe(true);
      const atRejection = h.states.find((st) => st.rejected === 1);
      expect(atRejection).toMatchObject({ pending: 0, rejected: 1, consecutiveFailures: 1, nextRetryAt: null });
      expect(h.queue.state().consecutiveFailures).toBe(0);
    });

    it('AMBIGUOUS: the originating flush resolves true after a 4xx that followed a retryable failure, so A12 ends consecutiveFailures at 0', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await h.fail();
      await expect(flushed).resolves.toBe(false);
      const retried = h.queue.retryNow();
      await settle();
      await h.fail(httpError(410));
      await expect(retried).resolves.toBe(true);
      expect(h.queue.state()).toEqual({ ...INITIAL, rejected: 1, showBar: true });
    });

    it('AMBIGUOUS: the originating flush does not start a second send on its own for a key re-dirtied in flight', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      h.queue.markDirty('a');
      await h.succeed(0);
      await expect(flushed).resolves.toBe(true);
      await settle();
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(h.queue.state().pending).toBe(1);
    });

    it('AMBIGUOUS: flush() waiting on a send that fails resolves false without an immediate extra send', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const p1 = h.queue.flush();
      await settle();
      h.queue.markDirty('b');
      const p2 = h.queue.flush();
      await settle();
      await h.fail(new Error('boom'), 0);
      await expect(p1).resolves.toBe(false);
      await expect(p2).resolves.toBe(false);
      expect(h.send).toHaveBeenCalledTimes(1); // the backoff timer owns the next attempt
      expect(h.timers.pending()).toBe(1);
      await h.timers.advance(100);
      expect(h.attempt(1).keys).toEqual(['a', 'b']);
    });

    it('AMBIGUOUS: a retry that fires with nothing left pending does not call send', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await h.fail();
      await expect(flushed).resolves.toBe(false);
      h.queue.unmark('a');
      expect(h.queue.state().pending).toBe(0);
      await h.timers.advance(60000);
      expect(h.send).toHaveBeenCalledTimes(1);
    });

    it('AMBIGUOUS: a successful flush() while a retry is scheduled clears nextRetryAt and the timer never sends', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const p1 = h.queue.flush();
      await settle();
      await h.fail();
      await expect(p1).resolves.toBe(false);
      const p2 = h.queue.flush();
      await settle();
      expect(h.send).toHaveBeenCalledTimes(2);
      await h.succeed(1);
      await expect(p2).resolves.toBe(true);
      expect(h.queue.state()).toEqual(INITIAL);
      await h.timers.advance(60000);
      expect(h.send).toHaveBeenCalledTimes(2);
    });

    it('AMBIGUOUS: nextRetryAt is Date.now() + the scheduled delay', CASE, async () => {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      try {
        const h = makeHarness();
        h.queue.markDirty('a');
        const flushed = h.queue.flush();
        await settle();
        await h.fail({ retryAfterMs: 5000 });
        await expect(flushed).resolves.toBe(false);
        expect(h.queue.state().nextRetryAt).toBe(1_700_000_000_000 + 5000);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('AMBIGUOUS: onChange receives a fresh state object per transition, not one mutated in place', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const afterMark = h.stateRefs[h.stateRefs.length - 1];
      expect(afterMark).toBeDefined();
      const flushed = h.queue.flush();
      await settle();
      await h.succeed();
      await expect(flushed).resolves.toBe(true);
      expect(afterMark).toEqual({ ...INITIAL, pending: 1 });
      expect(h.stateRefs[h.stateRefs.length - 1]).not.toBe(afterMark);
    });

    it('AMBIGUOUS: a flush() in flight at dispose() still settles with a boolean', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      h.queue.dispose();
      await h.succeed();
      const result = await flushed;
      expect(typeof result).toBe('boolean');
    });

    it('AMBIGUOUS: dispose() releases the scheduled retry timer through clearTimeout', CASE, async () => {
      const h = makeHarness();
      h.queue.markDirty('a');
      const flushed = h.queue.flush();
      await settle();
      await h.fail();
      await expect(flushed).resolves.toBe(false);
      expect(h.timers.pending()).toBe(1);
      h.queue.dispose();
      expect(h.timers.pending()).toBe(0);
      // And a failure that lands after dispose() schedules nothing at all.
      const late = makeHarness();
      late.queue.markDirty('a');
      void late.queue.flush();
      await settle();
      late.queue.dispose();
      await late.fail();
      expect(late.timers.pending()).toBe(0);
    });
  });
});
