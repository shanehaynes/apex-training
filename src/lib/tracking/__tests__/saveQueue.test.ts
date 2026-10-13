import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSaveQueue } from '../saveQueue';
import type { SaveQueueDeps, SaveQueueState } from '../saveQueue';

// The autosave queue's contract (the brief's A1–A9), at the seam: `send` is
// a controllable promise, timers are injected, and the clock is fake so
// backoff can be asserted to the millisecond.

interface Deferred {
  keys: string[];
  resolve: () => void;
  reject: (err?: unknown) => void;
}

function harness(over: Partial<SaveQueueDeps> = {}) {
  const sends: Deferred[] = [];
  const timers: { fn: () => void; ms: number; id: number; cleared: boolean }[] = [];
  let nextId = 1;
  const states: SaveQueueState[] = [];
  const queue = createSaveQueue({
    send: keys => new Promise<void>((resolve, reject) => { sends.push({ keys: [...keys], resolve, reject }); }),
    setTimeout: (fn, ms) => { const id = nextId++; timers.push({ fn, ms, id, cleared: false }); return id; },
    clearTimeout: handle => { const t = timers.find(x => x.id === handle); if (t) t.cleared = true; },
    onChange: s => { states.push(s); },
    ...over,
  });
  const live = () => timers.filter(t => !t.cleared);
  const fire = () => {
    const t = live()[0];
    if (!t) throw new Error('no timer scheduled');
    t.cleared = true;
    t.fn();
  };
  // Fail the newest send (flushing first if none is running) and settle.
  const rejectNext = async () => {
    const attempt = queue.state().inFlight ? null : queue.flush();
    sends.at(-1)!.reject(new Error('boom'));
    await (attempt ?? tick());
    await tick();
  };
  return { queue, sends, timers, live, fire, states, rejectNext };
}

// A macrotask hop past the queue's microtask chain; the fake clock still
// runs setTimeout(0) when advanced, so this awaits that advance.
async function tick() {
  await vi.advanceTimersByTimeAsync(0);
}

describe('createSaveQueue', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(1_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it('A5/A7: flush sends the distinct keys in first-dirtied order and resolves true on success', async () => {
    const h = harness();
    h.queue.markDirty('b');
    h.queue.markDirty('a');
    h.queue.markDirty('b');
    expect(h.queue.state().pending).toBe(2);
    const done = h.queue.flush();
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].keys).toEqual(['b', 'a']);
    expect(h.queue.state().inFlight).toBe(true);
    h.sends[0].resolve();
    await expect(done).resolves.toBe(true);
    expect(h.queue.state()).toEqual({ pending: 0, inFlight: false, consecutiveFailures: 0, showBar: false, nextRetryAt: null });
  });

  it('A5: with nothing pending, flush resolves true without sending', async () => {
    const h = harness();
    await expect(h.queue.flush()).resolves.toBe(true);
    expect(h.sends).toHaveLength(0);
  });

  it('A1: a key re-dirtied while its send is in flight stays pending and goes in the next send', async () => {
    const h = harness();
    h.queue.markDirty('a');
    h.queue.markDirty('b');
    const first = h.queue.flush();
    h.queue.markDirty('a');
    h.sends[0].resolve();
    await first;
    expect(h.queue.state().pending).toBe(1);
    const second = h.queue.flush();
    expect(h.sends[1].keys).toEqual(['a']);
    h.sends[1].resolve();
    await expect(second).resolves.toBe(true);
    expect(h.queue.state().pending).toBe(0);
  });

  it('A2: flush during a send waits, then sends once more; repeated flushes coalesce into one extra send', async () => {
    const h = harness();
    h.queue.markDirty('a');
    const first = h.queue.flush();
    h.queue.markDirty('b');
    const second = h.queue.flush();
    const third = h.queue.flush();
    expect(h.sends).toHaveLength(1);
    h.sends[0].resolve();
    await first;
    await tick();
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1].keys).toEqual(['b']);
    h.sends[1].resolve();
    await expect(second).resolves.toBe(true);
    await expect(third).resolves.toBe(true);
    expect(h.sends).toHaveLength(2);
  });

  it('A2/A5: a flush queued behind a send that covered everything resolves true with no extra send', async () => {
    const h = harness();
    h.queue.markDirty('a');
    const first = h.queue.flush();
    const second = h.queue.flush();
    h.sends[0].resolve();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(h.sends).toHaveLength(1);
  });

  it('A2: a flush waiting on a send that fails resolves false and leaves the retry to the backoff timer', async () => {
    const h = harness({ backoff: { baseMs: 100, maxMs: 1000 } });
    h.queue.markDirty('a');
    const first = h.queue.flush();
    h.queue.markDirty('b');
    const second = h.queue.flush();
    h.sends[0].reject(new Error('boom'));
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    await tick();
    expect(h.sends).toHaveLength(1);
    expect(h.queue.state()).toMatchObject({ pending: 2, consecutiveFailures: 1, nextRetryAt: 1_000_000 + 100 });
    expect(h.live()).toHaveLength(1);
    h.fire();
    expect(h.sends[1].keys).toEqual(['a', 'b']);
  });

  it('a key re-dirtied during a send is not drained by the flush that started it', async () => {
    const h = harness();
    h.queue.markDirty('a');
    const first = h.queue.flush();
    h.queue.markDirty('a');
    h.sends[0].resolve();
    await expect(first).resolves.toBe(true);
    await tick();
    expect(h.sends).toHaveLength(1);
    expect(h.queue.state().pending).toBe(1);
  });

  it('a successful manual flush while a retry is armed cancels the timer', async () => {
    const h = harness();
    h.queue.markDirty('a');
    await h.rejectNext();
    expect(h.live()).toHaveLength(1);
    const again = h.queue.flush();
    expect(h.live()).toHaveLength(0);
    h.sends[1].resolve();
    await expect(again).resolves.toBe(true);
    expect(h.queue.state().nextRetryAt).toBeNull();
  });

  it('a retry timer that fires with nothing pending does not send', async () => {
    const h = harness();
    h.queue.markDirty('a');
    await h.rejectNext();
    h.queue.unmark('a');
    h.fire();
    expect(h.sends).toHaveLength(1);
    expect(h.queue.state().nextRetryAt).toBeNull();
  });

  it('a flush in flight when dispose() is called still settles with its result', async () => {
    const h = harness();
    h.queue.markDirty('a');
    const attempt = h.queue.flush();
    h.queue.dispose();
    h.sends[0].resolve();
    await expect(attempt).resolves.toBe(true);
  });

  it('onChange receives a fresh object per transition', () => {
    const h = harness();
    h.queue.markDirty('a');
    h.queue.markDirty('b');
    expect(h.states).toHaveLength(2);
    expect(h.states[0]).not.toBe(h.states[1]);
    expect(h.states[0].pending).toBe(1);
    expect(h.states[1].pending).toBe(2);
  });

  it('A3/A5: on failure the keys stay pending, flush resolves false, and a retry is scheduled with exponential backoff', async () => {
    const h = harness({ backoff: { baseMs: 100, maxMs: 350 } });
    h.queue.markDirty('a');
    const attempt = h.queue.flush();
    h.sends[0].reject(new Error('boom'));
    await expect(attempt).resolves.toBe(false);
    expect(h.queue.state()).toMatchObject({ pending: 1, inFlight: false, consecutiveFailures: 1, nextRetryAt: 1_000_000 + 100 });
    expect(h.live()).toHaveLength(1);
    expect(h.live()[0].ms).toBe(100);

    h.fire();
    expect(h.sends[1].keys).toEqual(['a']);
    h.sends[1].reject(new Error('boom'));
    await tick();
    expect(h.queue.state().consecutiveFailures).toBe(2);
    expect(h.live()[0].ms).toBe(200);

    h.fire();
    h.sends[2].reject(new Error('boom'));
    await tick();
    expect(h.queue.state().consecutiveFailures).toBe(3);
    expect(h.live()[0].ms).toBe(350); // capped at maxMs, not 400

    h.fire();
    h.sends[3].resolve();
    await tick();
    expect(h.queue.state()).toEqual({ pending: 0, inFlight: false, consecutiveFailures: 0, showBar: false, nextRetryAt: null });
    expect(h.live()).toHaveLength(0);
  });

  it('A3: a rejection carrying retryAfterMs larger than the backoff wins', async () => {
    const h = harness({ backoff: { baseMs: 100, maxMs: 30_000 } });
    h.queue.markDirty('a');
    const attempt = h.queue.flush();
    h.sends[0].reject(Object.assign(new Error('429'), { retryAfterMs: 5000 }));
    await attempt;
    expect(h.live()[0].ms).toBe(5000);
    expect(h.queue.state().nextRetryAt).toBe(1_000_000 + 5000);
  });

  it('A3: a retryAfterMs smaller than the backoff does not shorten it', async () => {
    const h = harness({ backoff: { baseMs: 1000, maxMs: 30_000 } });
    h.queue.markDirty('a');
    const attempt = h.queue.flush();
    h.sends[0].reject(Object.assign(new Error('429'), { retryAfterMs: 10 }));
    await attempt;
    expect(h.live()[0].ms).toBe(1000);
  });

  it('A4: showBar after barAfterFailures consecutive failures, cleared by a success', async () => {
    const h = harness({ barAfterFailures: 2 });
    h.queue.markDirty('a');
    await h.rejectNext();
    expect(h.queue.state().showBar).toBe(false);
    h.fire();
    await h.rejectNext();
    expect(h.queue.state().showBar).toBe(true);
    h.fire();
    h.sends[2].resolve();
    await tick();
    expect(h.queue.state().showBar).toBe(false);
    expect(h.queue.state().consecutiveFailures).toBe(0);
  });

  it('A6: retryNow cancels the scheduled retry and sends immediately', async () => {
    const h = harness();
    h.queue.markDirty('a');
    await h.rejectNext();
    expect(h.live()).toHaveLength(1);
    const retry = h.queue.retryNow();
    expect(h.live()).toHaveLength(0);
    expect(h.queue.state().nextRetryAt).toBeNull();
    expect(h.sends).toHaveLength(2);
    h.sends[1].resolve();
    await expect(retry).resolves.toBe(true);
  });

  it('A8: keys dirtied during a failed send are included in the retry', async () => {
    const h = harness();
    h.queue.markDirty('a');
    const attempt = h.queue.flush();
    h.queue.markDirty('b');
    h.sends[0].reject(new Error('boom'));
    await attempt;
    expect(h.queue.state().pending).toBe(2);
    h.fire();
    expect(h.sends[1].keys).toEqual(['a', 'b']);
  });

  it('A9: onChange fires after each transition with the new state, matching state()', async () => {
    const h = harness();
    h.queue.markDirty('a');
    expect(h.states.at(-1)).toEqual(h.queue.state());
    expect(h.states.at(-1)?.pending).toBe(1);
    const attempt = h.queue.flush();
    expect(h.states.at(-1)?.inFlight).toBe(true);
    h.sends[0].reject(new Error('boom'));
    await attempt;
    expect(h.states.at(-1)).toEqual(h.queue.state());
    expect(h.states.at(-1)).toMatchObject({ inFlight: false, consecutiveFailures: 1, pending: 1 });
  });

  it('unmark drops a key so it is never sent', async () => {
    const h = harness();
    h.queue.markDirty('a');
    h.queue.markDirty('b');
    h.queue.unmark('a');
    expect(h.queue.state().pending).toBe(1);
    const done = h.queue.flush();
    expect(h.sends[0].keys).toEqual(['b']);
    h.sends[0].resolve();
    await done;
  });

  it('a key unmarked and re-marked mid-flight is not cleared by the older send', async () => {
    const h = harness();
    h.queue.markDirty('a');
    const first = h.queue.flush();
    h.queue.unmark('a');
    h.queue.markDirty('a');
    h.sends[0].resolve();
    await first;
    expect(h.queue.state().pending).toBe(1);
  });

  it('dispose cancels the retry; afterwards markDirty is ignored and flush resolves false without sending', async () => {
    const h = harness();
    h.queue.markDirty('a');
    await h.rejectNext();
    expect(h.live()).toHaveLength(1);
    h.queue.dispose();
    expect(h.live()).toHaveLength(0);
    expect(h.queue.state().nextRetryAt).toBeNull();
    h.queue.markDirty('b');
    expect(h.queue.state().pending).toBe(1);
    await expect(h.queue.flush()).resolves.toBe(false);
    await expect(h.queue.retryNow()).resolves.toBe(false);
    expect(h.sends).toHaveLength(1);
  });

  it('a send that fails after dispose schedules nothing', async () => {
    const h = harness();
    h.queue.markDirty('a');
    const attempt = h.queue.flush();
    h.queue.dispose();
    h.sends[0].reject(new Error('boom'));
    await expect(attempt).resolves.toBe(false);
    expect(h.live()).toHaveLength(0);
  });

  it('defaults to the global timers with a 1s base and 30s cap', async () => {
    const sends: Deferred[] = [];
    const queue = createSaveQueue({
      send: keys => new Promise<void>((resolve, reject) => { sends.push({ keys: [...keys], resolve, reject }); }),
    });
    queue.markDirty('a');
    const attempt = queue.flush();
    sends[0].reject(new Error('boom'));
    await expect(attempt).resolves.toBe(false);
    expect(queue.state().nextRetryAt).toBe(Date.now() + 1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(sends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sends).toHaveLength(2);
    sends[1].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.state().pending).toBe(0);
    queue.dispose();
  });
});
