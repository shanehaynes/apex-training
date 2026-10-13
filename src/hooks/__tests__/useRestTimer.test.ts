import { describe, it, expect, vi } from 'vitest';
import {
  claimRest, extendRest, EXPIRY_GRACE_MS, IDLE_REST, loggedRowKeys, remainingSeconds, restProgress, rowKey,
  settleRest, signalRestDone, startRest,
} from '../useRestTimer';
import { buildTrackerModel } from '../../lib/tracking/plan';
import type { TrackedSectionGroup } from '../../lib/tracking/plan';

// The transitions are pure over an injected `now` (no DOM environment here,
// so the hook's interval and listeners are proved by e2e/mock/rest-timer.
// spec.ts); what the tests pin is the arithmetic the bar and the row ledger
// are built on. `T` is an arbitrary epoch; the maths never reads the wall.

const T = 1_750_000_000_000;

describe('rest timer — transitions', () => {
  it('starts from an absolute end and derives what is left, rounding up', () => {
    const s = startRest(90, 'Weighted Pull-Ups', T);
    expect(s).toEqual({ endsAt: T + 90_000, startedAt: T, exerciseLabel: 'Weighted Pull-Ups', restSeconds: 90 });
    expect(remainingSeconds(s, T)).toBe(90);
    expect(remainingSeconds(s, T + 1_000)).toBe(89);
    // 0:01 until the end has actually passed.
    expect(remainingSeconds(s, T + 89_001)).toBe(1);
    expect(remainingSeconds(s, T + 90_000)).toBe(0);
    expect(remainingSeconds(s, T + 500_000)).toBe(0);
    expect(remainingSeconds(IDLE_REST, T)).toBe(0);
  });

  it('a backgrounded tab is a plain jump of the clock — nothing accumulates', () => {
    const s = startRest(120, 'Row', T);
    // No ticks for 30 s, then one: the answer is the same as thirty ticks.
    expect(remainingSeconds(s, T + 30_000)).toBe(90);
    expect(remainingSeconds(s, T + 119_000)).toBe(1);
  });

  it('+15 s goes on the end while running, on now once the end has passed', () => {
    const s = startRest(60, 'Row', T);
    expect(extendRest(s, T + 10_000).endsAt).toBe(T + 75_000);
    // Past zero (not yet settled by a tick): a full fifteen from now.
    expect(extendRest(s, T + 61_000).endsAt).toBe(T + 76_000);
    // Twice is thirty.
    expect(extendRest(extendRest(s, T + 10_000), T + 10_000).endsAt).toBe(T + 90_000);
    // Idle: nothing to extend.
    expect(extendRest(IDLE_REST, T)).toBe(IDLE_REST);
  });

  it('settles to idle once the end has passed, signalling only within the grace', () => {
    const s = startRest(60, 'Row', T);
    expect(settleRest(s, T + 59_999)).toEqual({ state: s, signal: false });
    expect(settleRest(s, T + 60_000)).toEqual({ state: IDLE_REST, signal: true });
    expect(settleRest(s, T + 60_000 + EXPIRY_GRACE_MS)).toEqual({ state: IDLE_REST, signal: true });
    // A tracker looked at minutes later clears the stale countdown without a beep.
    expect(settleRest(s, T + 60_000 + EXPIRY_GRACE_MS + 1)).toEqual({ state: IDLE_REST, signal: false });
    expect(settleRest(IDLE_REST, T)).toEqual({ state: IDLE_REST, signal: false });
  });

  it('progress runs 0 → 1 across the round and clamps', () => {
    const s = startRest(100, 'Row', T);
    expect(restProgress(s, T)).toBe(0);
    expect(restProgress(s, T + 25_000)).toBe(0.25);
    expect(restProgress(s, T + 100_000)).toBe(1);
    expect(restProgress(s, T + 200_000)).toBe(1);
    expect(restProgress(IDLE_REST, T)).toBe(1);
  });

  it('never starts a round shorter than a second', () => {
    expect(startRest(0.2, 'x', T).restSeconds).toBe(1);
  });
});

// ─── Rows ────────────────────────────────────────────────────────────────────

function groups(over: Partial<Record<'pullups' | 'row' | 'curl', Partial<{ restPeriod: string }>>> = {}): TrackedSectionGroup[] {
  return buildTrackerModel({
    id: 'evt', title: 'Pull day', date: '2026-10-10', type: 'weights',
    exercises: [
      { id: 'pullups', name: 'Weighted Pull-Ups', category: 'strength', sets: 3, reps: '5', restPeriod: '90s', ...over.pullups },
      { id: 'row', name: 'Barbell Row', category: 'strength', sets: 3, reps: '6', restPeriod: '2-3 min', ...over.row },
      { id: 'curl', name: 'Hammer Curl', category: 'strength', sets: 2, reps: '12', restPeriod: 'as needed', ...over.curl },
    ],
  } as Parameters<typeof buildTrackerModel>[0]);
}

describe('rest timer — row ledger', () => {
  it('keys a row by section, exercise and set', () => {
    expect(rowKey('exercise', 'pullups', 2)).toBe('exercise/pullups/2');
    expect(rowKey('warmup', 'pullups', 2)).not.toBe(rowKey('exercise', 'pullups', 2));
  });

  it('a row starts the rest its exercise prescribes, once (R2.2)', () => {
    const started = new Set<string>();
    expect(claimRest(groups(), started, 'exercise', 'pullups', 1)).toEqual({ seconds: 90, label: 'Weighted Pull-Ups' });
    // A later edit of the same row never restarts.
    expect(claimRest(groups(), started, 'exercise', 'pullups', 1)).toBeNull();
    // Another row of the same exercise is a new set.
    expect(claimRest(groups(), started, 'exercise', 'pullups', 2)).toEqual({ seconds: 90, label: 'Weighted Pull-Ups' });
    expect(started).toEqual(new Set(['exercise/pullups/1', 'exercise/pullups/2']));
  });

  it('a range takes its low end; unparseable rest claims the row but starts nothing (R2.5)', () => {
    const started = new Set<string>();
    expect(claimRest(groups(), started, 'exercise', 'row', 1)).toEqual({ seconds: 120, label: 'Barbell Row' });
    expect(claimRest(groups(), started, 'exercise', 'curl', 1)).toBeNull();
    expect(started.has('exercise/curl/1')).toBe(true);
    expect(claimRest(groups({ curl: { restPeriod: '' } }), new Set(), 'exercise', 'curl', 1)).toBeNull();
  });

  it('an exercise that is not on screen starts nothing', () => {
    expect(claimRest(groups(), new Set(), 'exercise', 'missing', 1)).toBeNull();
    expect(claimRest(groups(), new Set(), 'warmup', 'pullups', 1)).toBeNull();
    expect(claimRest(null, new Set(), 'exercise', 'pullups', 1)).toBeNull();
  });

  it('rows already holding reps or a duration when the tracker loads are spent (R2.4)', () => {
    const g = groups();
    g[0].exercises[0].sets[0].actualReps = '5';
    g[0].exercises[1].sets[1].actualDuration = '0:45';
    // Weight alone is not a logged set for the timer.
    g[0].exercises[2].sets[0].actualWeight = '35';
    g[0].exercises[2].sets[1].actualReps = '   ';
    expect(loggedRowKeys(g)).toEqual(['exercise/pullups/1', 'exercise/row/2']);

    const started = new Set(loggedRowKeys(g));
    expect(claimRest(g, started, 'exercise', 'pullups', 1)).toBeNull();
    expect(claimRest(g, started, 'exercise', 'pullups', 2)).toEqual({ seconds: 90, label: 'Weighted Pull-Ups' });
  });
});

// ─── The signal at zero ──────────────────────────────────────────────────────

function fakeAudio(state: 'running' | 'suspended') {
  const osc = { type: '', frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null as null | (() => void) };
  const gainNode = { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() };
  osc.connect.mockReturnValue(gainNode);
  const close = vi.fn(async () => {});
  const ctx = { state, currentTime: 0, destination: {}, createOscillator: () => osc, createGain: () => gainNode, close };
  return { ctor: vi.fn(function () { return ctx; }) as unknown as new () => typeof ctx, osc, close };
}

describe('rest timer — the signal at zero', () => {
  it('beeps once and buzzes 200 ms where both are available', () => {
    const audio = fakeAudio('running');
    const vibrate = vi.fn(() => true);
    signalRestDone({ AudioContext: audio.ctor as never, navigator: { vibrate } });
    expect(audio.osc.start).toHaveBeenCalledTimes(1);
    expect(audio.osc.stop).toHaveBeenCalledTimes(1);
    expect(audio.osc.frequency.value).toBe(880);
    expect(vibrate).toHaveBeenCalledWith(200);
    // The context is released once the tone ends, not before.
    expect(audio.close).not.toHaveBeenCalled();
    audio.osc.onended?.();
    expect(audio.close).toHaveBeenCalledTimes(1);
  });

  it('stays silent, and releases the context, when no gesture has unlocked audio', () => {
    const audio = fakeAudio('suspended');
    signalRestDone({ AudioContext: audio.ctor as never, navigator: {} });
    expect(audio.osc.start).not.toHaveBeenCalled();
    expect(audio.close).toHaveBeenCalledTimes(1);
  });

  it('never throws: no audio, no vibrate, a constructor that refuses, a vibrate that throws', () => {
    expect(() => signalRestDone({})).not.toThrow();
    expect(() => signalRestDone({ navigator: {} })).not.toThrow();
    const refusing = vi.fn(function () { throw new Error('blocked'); }) as unknown as new () => never;
    const vibrate = vi.fn(() => true);
    signalRestDone({ AudioContext: refusing, navigator: { vibrate } });
    expect(vibrate).toHaveBeenCalledWith(200);
    expect(() => signalRestDone({ navigator: { vibrate: () => { throw new Error('no'); } } })).not.toThrow();
  });
});
