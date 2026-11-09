import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RUNAWAY_FLOOR_SECONDS, RUNAWAY_PLAN_MULTIPLE,
  detectRunaway, formatRunawayLength, isRunaway, latestLoggedAt, suggestFinish,
} from '../runawayFinish';

// The contract iOS ports (D-061): one file, both suites.
interface Vector {
  name: string;
  startedAt: string;
  now: string;
  plannedMinutes: number | null;
  lastLoggedAt: string | null;
  expect: {
    runaway: boolean;
    suggestedAt: string;
    basis: 'last-logged' | 'plan' | 'now';
    elapsedLabel: string;
    plannedLabel: string | null;
  };
}
const VECTORS = JSON.parse(readFileSync(
  resolve(__dirname, '../../../../ios/Packages/ApexCore/Tests/ApexCoreTests/Fixtures/runaway-finish.json'),
  'utf8',
)) as { rule: { planMultiple: number; floorSeconds: number }; cases: Vector[] };

const clockOf = (v: Vector) => ({
  startedAtMs: Date.parse(v.startedAt),
  nowMs: Date.parse(v.now),
  plannedMinutes: v.plannedMinutes,
  lastLoggedMs: v.lastLoggedAt === null ? null : Date.parse(v.lastLoggedAt),
});

describe('runawayFinish — the shared vectors', () => {
  it('states the same rule the module holds', () => {
    expect(VECTORS.rule).toEqual({ planMultiple: RUNAWAY_PLAN_MULTIPLE, floorSeconds: RUNAWAY_FLOOR_SECONDS });
    expect(VECTORS.cases.length).toBeGreaterThanOrEqual(19);
  });

  it.each(VECTORS.cases.map(v => [v.name, v] as const))('isRunaway / detectRunaway: %s', (_name, v) => {
    const clock = clockOf(v);
    expect(isRunaway((clock.nowMs - clock.startedAtMs) / 1000, v.plannedMinutes)).toBe(v.expect.runaway);
    const detected = detectRunaway(clock);
    expect(detected !== null).toBe(v.expect.runaway);
    if (detected) {
      expect(detected.suggestion).toEqual({ atMs: Date.parse(v.expect.suggestedAt), basis: v.expect.basis });
      expect(detected.plannedMinutes).toBe(v.plannedMinutes);
    }
  });

  it.each(VECTORS.cases.map(v => [v.name, v] as const))('suggestFinish and the labels: %s', (_name, v) => {
    const clock = clockOf(v);
    expect(suggestFinish(clock)).toEqual({ atMs: Date.parse(v.expect.suggestedAt), basis: v.expect.basis });
    expect(formatRunawayLength((clock.nowMs - clock.startedAtMs) / 1000)).toBe(v.expect.elapsedLabel);
    if (v.expect.plannedLabel !== null) expect(formatRunawayLength(v.plannedMinutes! * 60)).toBe(v.expect.plannedLabel);
  });
});

describe('runawayFinish — what JSON cannot carry', () => {
  it('a non-finite plan or elapsed time is never a runaway', () => {
    expect(isRunaway(10 * 3600, Number.NaN)).toBe(false);
    expect(isRunaway(10 * 3600, Number.POSITIVE_INFINITY)).toBe(false);
    expect(isRunaway(10 * 3600, undefined)).toBe(false);
    expect(isRunaway(Number.NaN, 30)).toBe(false);
    expect(isRunaway(Number.POSITIVE_INFINITY, 30)).toBe(false);
  });

  it('a non-finite last log falls back to the plan', () => {
    const startedAtMs = Date.parse('2026-10-01T10:00:00Z');
    expect(suggestFinish({ startedAtMs, nowMs: startedAtMs + 5 * 3600_000, plannedMinutes: 30, lastLoggedMs: Number.NaN }))
      .toEqual({ atMs: startedAtMs + 30 * 60_000, basis: 'plan' });
  });
});

describe('latestLoggedAt', () => {
  it('is the latest updated_at among rows the athlete logged, as the row carried it', () => {
    expect(latestLoggedAt([
      { updated_at: '2026-09-11T22:31:00+00:00', is_autofilled: false },
      { updated_at: '2026-09-11T22:46:00.512+00:00', is_autofilled: false },
      { updated_at: '2026-09-11T22:40:00+00:00' },
    ])).toBe('2026-09-11T22:46:00.512+00:00');
  });

  it('skips autofilled rows and rows with no readable stamp', () => {
    expect(latestLoggedAt([
      { updated_at: '2026-09-11T22:31:00Z', is_autofilled: false },
      { updated_at: '2026-09-21T16:18:26Z', is_autofilled: true },
      { updated_at: 'not a time', is_autofilled: false },
      { updated_at: null, is_autofilled: false },
      {},
    ])).toBe('2026-09-11T22:31:00Z');
  });

  it('is null with nothing logged', () => {
    expect(latestLoggedAt([])).toBeNull();
    expect(latestLoggedAt([{ updated_at: '2026-09-21T16:18:26Z', is_autofilled: true }])).toBeNull();
  });
});

describe('formatRunawayLength', () => {
  it('reads like a timer: whole minutes, rounded down', () => {
    expect(formatRunawayLength(0)).toBe('0 min');
    expect(formatRunawayLength(59)).toBe('0 min');
    expect(formatRunawayLength(-5)).toBe('0 min');
    expect(formatRunawayLength(3600)).toBe('1 h');
    expect(formatRunawayLength(86_400)).toBe('1 d');
    expect(formatRunawayLength(86_400 + 59 * 60)).toBe('1 d');
  });
});
