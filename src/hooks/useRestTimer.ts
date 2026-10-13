import { useCallback, useEffect, useRef, useState } from 'react';
import type { TrackedSection } from '../lib/db/types';
import type { TrackedSectionGroup } from '../lib/tracking/plan';
import { parseRestSeconds } from '../lib/tracking/rest';

/**
 * The rest countdown between sets (D-015 on web). It stores the absolute
 * `endsAt` and never decrements: the bar derives what is left from the clock
 * on each tick, so a tab that was throttled or asleep reads right the moment
 * it is back. The transitions are pure functions of an injected `now`, which
 * is how the unit tests drive them; the hook adds the interval and the
 * one-shot signal at zero.
 *
 * Semantics match the iOS tracker (ios/.../Tracker/RestTimer.swift): +15 s
 * goes on the end, or on `now` once the end has passed; the signal fires only
 * when the end passed within a short grace of the tick, so a tracker that
 * comes back minutes late clears the stale countdown without a beep.
 */

export const EXTEND_SECONDS = 15;
/** How long after zero a tick still counts as "just now" — one tick plus slack. */
export const EXPIRY_GRACE_MS = 2000;

export interface RestTimerState {
  /** Epoch ms the current rest ends; null when none is running. */
  endsAt: number | null;
  /** Epoch ms the round started — with endsAt, its length, for a progress line. */
  startedAt: number | null;
  /** The exercise the rest belongs to, for the bar. */
  exerciseLabel: string;
  /** The prescription the round started from, in seconds. */
  restSeconds: number;
}

export const IDLE_REST: RestTimerState = { endsAt: null, startedAt: null, exerciseLabel: '', restSeconds: 0 };

export function startRest(seconds: number, label: string, now: number): RestTimerState {
  const whole = Math.max(1, Math.round(seconds));
  return { endsAt: now + whole * 1000, startedAt: now, exerciseLabel: label, restSeconds: whole };
}

/** +15 s onto the end, or onto `now` when the end has passed. No-op when idle. */
export function extendRest(state: RestTimerState, now: number, seconds = EXTEND_SECONDS): RestTimerState {
  if (state.endsAt === null) return state;
  return { ...state, endsAt: Math.max(state.endsAt, now) + seconds * 1000 };
}

/** Whole seconds left, rounded up so the bar reads 0:01 until the end has passed. */
export function remainingSeconds(state: RestTimerState, now: number): number {
  if (state.endsAt === null) return 0;
  return Math.max(0, Math.ceil((state.endsAt - now) / 1000));
}

/** 0 at the start of the round, 1 at its end (or when idle). */
export function restProgress(state: RestTimerState, now: number): number {
  if (state.endsAt === null || state.startedAt === null || state.endsAt <= state.startedAt) return 1;
  return Math.min(1, Math.max(0, (now - state.startedAt) / (state.endsAt - state.startedAt)));
}

/**
 * The tick: once the end has passed the timer clears itself. `signal` is true
 * only when the end passed within the grace — the beep fires at zero, never late.
 */
export function settleRest(state: RestTimerState, now: number): { state: RestTimerState; signal: boolean } {
  if (state.endsAt === null || now < state.endsAt) return { state, signal: false };
  return { state: IDLE_REST, signal: now - state.endsAt <= EXPIRY_GRACE_MS };
}

// ─── Rows ────────────────────────────────────────────────────────────────────

export function rowKey(section: TrackedSection, exerciseId: string, setNumber: number): string {
  return `${section}/${exerciseId}/${setNumber}`;
}

/** Set rows already holding reps or a duration — "spent" for the timer (R2.4). */
export function loggedRowKeys(groups: TrackedSectionGroup[]): string[] {
  const keys: string[] = [];
  for (const group of groups) {
    for (const tracked of group.exercises) {
      for (const set of tracked.sets) {
        if (set.actualReps.trim() || set.actualDuration.trim()) keys.push(rowKey(group.section, tracked.exercise.id, set.setNumber));
      }
    }
  }
  return keys;
}

/**
 * A set row committed (its reps or duration went empty → non-empty, or its
 * ghost was tapped). Claims the row in `started` and answers the rest to
 * run, or null: the row already started a timer this session, the exercise
 * is not on screen, or its rest text does not parse. The claim happens
 * either way — a row never starts twice (R2.2), parseable rest or not.
 */
export function claimRest(
  groups: TrackedSectionGroup[] | null,
  started: Set<string>,
  section: TrackedSection,
  exerciseId: string,
  setNumber: number,
): { seconds: number; label: string } | null {
  const key = rowKey(section, exerciseId, setNumber);
  if (started.has(key)) return null;
  started.add(key);
  const tracked = groups?.find(g => g.section === section)?.exercises.find(t => t.exercise.id === exerciseId);
  if (!tracked) return null;
  const seconds = parseRestSeconds(tracked.exercise.restPeriod);
  return seconds === null ? null : { seconds, label: tracked.exercise.name };
}

// ─── The signal at zero ──────────────────────────────────────────────────────

interface AudioContextLike {
  state: string;
  currentTime: number;
  destination: AudioNode;
  createOscillator(): OscillatorNode;
  createGain(): GainNode;
  close(): Promise<void>;
}

export interface SignalScope {
  AudioContext?: new () => AudioContextLike;
  webkitAudioContext?: new () => AudioContextLike;
  navigator?: { vibrate?: (pattern: number) => boolean };
}

/**
 * A short beep and a 200 ms buzz, each only where it can happen: an
 * AudioContext made outside a user gesture stays suspended (no sound, no
 * error), and `vibrate` is absent on desktop and iOS. Nothing here throws.
 */
export function signalRestDone(scope: SignalScope = globalThis as SignalScope): void {
  try {
    const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
    if (Ctor) {
      const ctx = new Ctor();
      if (ctx.state === 'running') {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        const t = ctx.currentTime;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.4);
        osc.onended = () => { void ctx.close().catch(() => {}); };
      } else {
        void ctx.close().catch(() => {});
      }
    }
  } catch {
    // No audio here; the bar and the buzz still say it.
  }
  try {
    scope.navigator?.vibrate?.(200);
  } catch {
    // Unsupported or blocked — nothing to do.
  }
}

// ─── The hook ────────────────────────────────────────────────────────────────

export interface RestTimer extends RestTimerState {
  running: boolean;
  /** Whole seconds left as of the last tick. */
  remaining: number;
  /** 0 → 1 across the round, as of the last tick. */
  progress: number;
  remainingAt(now: number): number;
  start(seconds: number, label: string): void;
  extend(): void;
  skip(): void;
}

export function useRestTimer(clock: () => number = Date.now): RestTimer {
  const [state, setState] = useState<RestTimerState>(IDLE_REST);
  const [now, setNow] = useState(() => clock());
  // Mirrors `state` for handlers that run outside render (the tick, the
  // buttons), so the signal is a plain side effect and never lives inside a
  // state updater, which StrictMode calls twice.
  const stateRef = useRef(state);
  const update = useCallback((next: RestTimerState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const tick = useCallback(() => {
    const t = clock();
    const { state: next, signal } = settleRest(stateRef.current, t);
    if (next !== stateRef.current) update(next);
    if (signal) signalRestDone();
    setNow(t);
  }, [clock, update]);

  const running = state.endsAt !== null;

  useEffect(() => {
    if (!running) return;
    const interval = setInterval(tick, 1000);
    // A background tab's interval is throttled; the clock is not. Re-derive
    // the moment the tab is looked at again rather than at the next tick.
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', tick);
    };
  }, [running, tick]);

  const start = useCallback((seconds: number, label: string) => {
    const t = clock();
    setNow(t);
    update(startRest(seconds, label, t));
  }, [clock, update]);

  const extend = useCallback(() => {
    const t = clock();
    setNow(t);
    update(extendRest(stateRef.current, t));
  }, [clock, update]);

  const skip = useCallback(() => update(IDLE_REST), [update]);

  return {
    ...state,
    running,
    remaining: remainingSeconds(state, now),
    progress: restProgress(state, now),
    remainingAt: (at: number) => remainingSeconds(state, at),
    start,
    extend,
    skip,
  };
}

export interface TrackerRestTimer extends RestTimer {
  /** A set row's first non-empty reps/duration, or its ghost tapped (R2.1, R2.2). */
  commit(section: TrackedSection, exerciseId: string, setNumber: number): boolean;
}

/**
 * The tracker's rest timer: `useRestTimer` plus the row ledger (R2.4) —
 * which rows have started a timer this session, seeded with the rows that
 * were already logged when the session's model arrived, and reset with the
 * session. A finished workout starts nothing and drops any countdown.
 */
export function useTrackerRestTimer({ groups, sessionKey, finished, clock }: {
  groups: TrackedSectionGroup[] | null;
  /** The tracked occurrence; a change is a new session. */
  sessionKey: string | null;
  finished: boolean;
  clock?: () => number;
}): TrackerRestTimer {
  const timer = useRestTimer(clock);
  const { start, skip } = timer;
  const started = useRef(new Set<string>());
  // The session hook keeps the previous session's groups on screen until the
  // next bootstrap lands, so the rows to mark as spent are the first `groups`
  // object that is not the one present when the session changed.
  const seed = useRef<{ key: string | null; stale: TrackedSectionGroup[] | null; done: boolean }>({ key: null, stale: null, done: false });

  useEffect(() => {
    if (seed.current.key === sessionKey) return;
    seed.current = { key: sessionKey, stale: groups, done: false };
    started.current = new Set();
    skip();
    // `groups` is read for its identity at the moment the session changes only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, skip]);

  useEffect(() => {
    const s = seed.current;
    if (s.done || !groups || groups === s.stale) return;
    s.done = true;
    for (const key of loggedRowKeys(groups)) started.current.add(key);
  }, [groups]);

  useEffect(() => {
    if (finished) skip();
  }, [finished, skip]);

  const commit = (section: TrackedSection, exerciseId: string, setNumber: number): boolean => {
    if (finished) return false;
    const rest = claimRest(groups, started.current, section, exerciseId, setNumber);
    if (!rest) return false;
    start(rest.seconds, rest.label);
    return true;
  };

  return { ...timer, commit };
}
