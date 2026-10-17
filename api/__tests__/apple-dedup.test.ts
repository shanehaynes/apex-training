import { describe, it, expect } from 'vitest';
import { classifyApple } from '../_lib/providers/sync';
import { APEX_BUNDLE_ID, parseAppleActivity } from '../_lib/providers/apple/activity';
import type { ProviderActivity } from '../_lib/providers/coros/client';

// classifyApple, rule by rule (W16 M2b): when a Health workout is set aside
// rather than imported. Each case isolates one rule so deleting it fails here.

const NOW = Date.parse('2026-10-17T18:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

type Ctx = Parameters<typeof classifyApple>[1];

function ctx(over: Partial<Ctx> = {}): Ctx {
  return {
    provider: 'apple', activities: [], occurrences: [], completedKeys: new Set(), ledgerActivityIds: new Set(),
    ledgerFilledKeys: new Set(), windowStartIso: '', sessions: [], otherProviderActivities: [], ...over,
  } as Ctx;
}

function activity(startMs: number, durationMin: number, over: Partial<ProviderActivity> = {}): ProviderActivity {
  return {
    provider: 'apple', activityId: 'w', sport: 37, startUtc: new Date(startMs).toISOString(), durationSec: durationMin * 60,
    summaryExtras: { endUtc: new Date(startMs + durationMin * MIN).toISOString() }, ...over,
  };
}

describe('classifyApple', () => {
  it('imports a workout nothing else accounts for', () => {
    expect(classifyApple(activity(NOW - 2 * HOUR, 45), ctx(), NOW)).toBeNull();
  });

  it('already-imported and own-app come first', () => {
    expect(classifyApple(activity(NOW - HOUR, 30), ctx({ ledgerActivityIds: new Set(['w']) }), NOW)).toBe('already-imported');
    const own = activity(NOW - HOUR, 30, { summaryExtras: { sourceBundleId: APEX_BUNDLE_ID } });
    expect(classifyApple(own, ctx(), NOW)).toBe('own-app');
  });

  it('out-of-window: older than 30 days, or more than 5 minutes ahead', () => {
    expect(classifyApple(activity(NOW - 31 * 24 * HOUR, 30), ctx(), NOW)).toBe('out-of-window');
    expect(classifyApple(activity(NOW + 6 * MIN, 30), ctx(), NOW)).toBe('out-of-window');
    expect(classifyApple(activity(NOW + 4 * MIN, 30), ctx(), NOW)).toBeNull();
  });

  it('a Watch workout recorded alongside a finished tracker session is a duplicate', () => {
    const session = { start: NOW - 3 * HOUR, end: NOW - 2 * HOUR };
    expect(classifyApple(activity(NOW - 3 * HOUR + 5 * MIN, 50), ctx({ sessions: [session] }), NOW)).toBe('duplicate');
  });

  it('a workout that merely touches a session is not', () => {
    // A walk home whose first minute overlaps the strength session's last.
    const session = { start: NOW - 3 * HOUR, end: NOW - 2 * HOUR };
    expect(classifyApple(activity(NOW - 2 * HOUR - MIN, 30), ctx({ sessions: [session] }), NOW)).toBeNull();
  });

  it('a zero-length session — a quick-complete, a coach log — is a tap, never a workout', () => {
    const tap = { start: NOW - HOUR, end: NOW - HOUR };
    expect(classifyApple(activity(NOW - 2 * HOUR, 120), ctx({ sessions: [tap] }), NOW)).toBeNull();
  });

  it('an open session is in progress, until it is abandoned', () => {
    const open = { start: NOW - 20 * MIN, end: null };
    expect(classifyApple(activity(NOW - 10 * MIN, 5), ctx({ sessions: [open] }), NOW)).toBe('in-progress');
    const abandoned = { start: NOW - 30 * HOUR, end: null };
    expect(classifyApple(activity(NOW - 28 * HOUR, 60), ctx({ sessions: [abandoned] }), NOW)).toBeNull();
  });

  it("another provider's copy: start within 2 minutes, duration within 10 %", () => {
    const coros = [{ start: NOW - 3 * HOUR + MIN, durationSec: 2820 }];
    expect(classifyApple(activity(NOW - 3 * HOUR, 45), ctx({ otherProviderActivities: coros }), NOW)).toBe('duplicate');
    expect(classifyApple(activity(NOW - 3 * HOUR - 5 * MIN, 45), ctx({ otherProviderActivities: coros }), NOW)).toBeNull();
    expect(classifyApple(activity(NOW - 3 * HOUR, 60), ctx({ otherProviderActivities: coros }), NOW)).toBeNull();
  });

  it("a paused workout is judged by the span Health recorded, not its moving time", () => {
    // 20 minutes moving across a 60-minute span, fully inside a session.
    const paused = activity(NOW - 3 * HOUR, 20, { summaryExtras: { endUtc: new Date(NOW - 2 * HOUR).toISOString() } });
    const session = { start: NOW - 3 * HOUR, end: NOW - 2 * HOUR };
    expect(classifyApple(paused, ctx({ sessions: [session] }), NOW)).toBe('duplicate');
  });
});

describe('parseAppleActivity hardening', () => {
  const base = {
    activityId: '6F1E2D3C-0000-4000-8000-000000000001', activityType: 37, sourceName: 'Apple Watch',
    startUtc: '2026-10-15T13:00:00Z', endUtc: '2026-10-15T13:45:00Z', durationSec: 2700, avgHr: 140,
  };

  it('never lets summaryExtras set what the server computes or the coach reads', () => {
    const parsed = parseAppleActivity({
      ...base,
      summaryExtras: { avgHr: 999, trainingLoad: 500, hrv: 200, hrZones: [1, 2], durationSec: 1, sourceBundleId: APEX_BUNDLE_ID, cadence: 82 },
    });
    expect(parsed?.avgHr).toBe(140);
    expect(parsed?.durationSec).toBe(2700);
    expect(parsed?.summaryExtras).toEqual({ cadence: 82, endUtc: '2026-10-15T13:45:00.000Z', sourceName: 'Apple Watch' });
  });

  it('refuses a duration longer than the recorded span, and a non-ISO instant', () => {
    expect(parseAppleActivity({ ...base, durationSec: 2700 + 61 })).toBeNull();
    expect(parseAppleActivity({ ...base, durationSec: 1200 })).not.toBeNull(); // paused: shorter is fine
    expect(parseAppleActivity({ ...base, startUtc: 'Oct 15 2026 13:00' })).toBeNull();
    expect(parseAppleActivity({ ...base, endUtc: '2026-10-15 13:45' })).toBeNull();
  });

  it('keeps activity ids to a UUID-safe charset, so event ids never collide', () => {
    expect(parseAppleActivity({ ...base, activityId: 'a.b' })).toBeNull();
    expect(parseAppleActivity({ ...base, activityId: 'a b' })).toBeNull();
  });

  it('sorts HR points by time', () => {
    const parsed = parseAppleActivity({ ...base, streams: { hr: [[120, 150], [0, 110], [60, 140]] } });
    expect(parsed?.streams?.hr).toEqual([[0, 110], [60, 140], [120, 150]]);
  });
});
