import { describe, it, expect } from 'vitest';
import type { CardioLogRow, CompletionRow, SetLogRow, WorkoutSessionRow } from '../../db/types';
import { buildReviewPeriod, computePeriodPRs, computeReviewStats, computeYearlyStats } from '../stats';
import type { ReviewInputs } from '../types';

// Month 6 of ISO 2026: May 18 – Jun 14 (endExclusive Jun 15).
const MONTH = buildReviewPeriod('month', 2026, 6);
// ISO 2026 (53 weeks): Dec 29 2025 – Jan 3 2027.
const YEAR = buildReviewPeriod('year', 2026);

let setCounter = 0;

function makeSet(
  date: string,
  name: string,
  weight: string | null,
  reps: string | null,
  overrides: Partial<SetLogRow> = {},
): SetLogRow {
  setCounter += 1;
  return {
    event_id: `evt-${date}`,
    event_date: date,
    section: 'exercise',
    exercise_id: name.toLowerCase().replaceAll(' ', '-'),
    exercise_name: name,
    set_number: setCounter,
    planned_weight: null,
    planned_reps: null,
    planned_duration: null,
    actual_weight: weight,
    actual_reps: reps,
    actual_duration: null,
    is_autofilled: false,
    ...overrides,
  };
}

function makeCardio(
  date: string,
  name: string,
  distance: string | null,
  elevation: string | null,
  overrides: Partial<CardioLogRow> = {},
): CardioLogRow {
  return {
    event_id: `evt-${date}`,
    event_date: date,
    section: 'exercise',
    exercise_id: name.toLowerCase().replaceAll(' ', '-'),
    exercise_name: name,
    duration_minutes: 45,
    distance,
    elevation_gain: elevation,
    avg_heart_rate: null,
    is_autofilled: false,
    ...overrides,
  };
}

function makeCompletion(date: string, type: string, overrides: Partial<CompletionRow> = {}): CompletionRow {
  return {
    event_id: `evt-${date}-${type}`,
    event_date: date,
    event_type: type,
    event_title: `${type} session`,
    duration_minutes: 60,
    is_completed: true,
    completed_at: `${date}T12:00:00Z`,
    updated_at: `${date}T12:00:00Z`,
    ...overrides,
  };
}

function makeSession(date: string, eventId: string, seconds: number | null, summary: string | null = null): WorkoutSessionRow {
  return {
    id: `session-${date}-${eventId}`,
    event_id: eventId,
    event_date: date,
    started_at: `${date}T10:00:00Z`,
    finished_at: `${date}T11:00:00Z`,
    total_duration_seconds: seconds,
    coach_summary: summary,
    updated_at: `${date}T11:00:00Z`,
  };
}

function inputs(partial: Partial<ReviewInputs>): ReviewInputs {
  return { period: MONTH, completions: [], sessions: [], setLogs: [], cardioLogs: [], ...partial };
}

describe('computePeriodPRs', () => {
  it('detects an in-period lift that beats prior history', () => {
    const prs = computePeriodPRs(
      [makeSet('2026-04-01', 'Bench Press', '100', '5'), makeSet('2026-05-20', 'Bench Press', '110', '5')],
      [],
      MONTH,
    );
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ kind: 'oneRM', exerciseName: 'Bench Press', date: '2026-05-20', previousDate: '2026-04-01' });
  });

  it('never counts a first-ever log as a PR', () => {
    expect(computePeriodPRs([makeSet('2026-05-20', 'Deadlift', '140', '3')], [], MONTH)).toHaveLength(0);
  });

  it('reads a bare-number duration as minutes (a stretch "2" is 2:00)', () => {
    const prs = computePeriodPRs(
      [
        makeSet('2026-04-01', 'Hamstring Stretch', null, null, { actual_duration: '1' }), // 1:00
        makeSet('2026-05-20', 'Hamstring Stretch', null, null, { actual_duration: '2' }), // 2:00 → PR
      ],
      [],
      MONTH,
    );
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ kind: 'duration', seconds: 120, previousSeconds: 60 });
  });

  it('treats a multi-digit bare duration as seconds, not minutes', () => {
    // "90" is 90 seconds; a later "1:30" (also 90s) ties it, so no PR.
    const prs = computePeriodPRs(
      [
        makeSet('2026-04-01', 'Wall Sit', null, null, { actual_duration: '90' }),
        makeSet('2026-05-20', 'Wall Sit', null, null, { actual_duration: '1:30' }),
      ],
      [],
      MONTH,
    );
    expect(prs).toHaveLength(0);
  });

  it('does not PR when a bare-minute value loses to an earlier colon time', () => {
    // Prior "2" = 2:00 (120s); later "1:30" = 90s is a regression, not a PR.
    const prs = computePeriodPRs(
      [
        makeSet('2026-04-01', 'Hamstring Stretch', null, null, { actual_duration: '2' }),
        makeSet('2026-05-20', 'Hamstring Stretch', null, null, { actual_duration: '1:30' }),
      ],
      [],
      MONTH,
    );
    expect(prs).toHaveLength(0);
  });

  it('ignores bests set before the period', () => {
    const prs = computePeriodPRs(
      [makeSet('2026-03-01', 'Squat', '120', '5'), makeSet('2026-04-01', 'Squat', '130', '5')],
      [],
      MONTH,
    );
    expect(prs).toHaveLength(0);
  });

  it('emits one PR per exercise per day, compared against the pre-day best', () => {
    const prs = computePeriodPRs(
      [
        makeSet('2026-04-01', 'Bench Press', '100', '5'),
        makeSet('2026-05-20', 'Bench Press', '105', '5'),
        makeSet('2026-05-20', 'Bench Press', '110', '5'),
      ],
      [],
      MONTH,
    );
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ kind: 'oneRM', weight: 110, previousDate: '2026-04-01' });
  });

  it('can PR the same exercise on multiple days within the period', () => {
    const prs = computePeriodPRs(
      [
        makeSet('2026-04-01', 'Bench Press', '100', '5'),
        makeSet('2026-05-20', 'Bench Press', '105', '5'),
        makeSet('2026-06-03', 'Bench Press', '110', '5'),
      ],
      [],
      MONTH,
    );
    expect(prs.map(pr => pr.date)).toEqual(['2026-05-20', '2026-06-03']);
  });

  it('skips autofilled sets', () => {
    const prs = computePeriodPRs(
      [
        makeSet('2026-04-01', 'Bench Press', '100', '5'),
        makeSet('2026-05-20', 'Bench Press', '200', '5', { is_autofilled: true }),
      ],
      [],
      MONTH,
    );
    expect(prs).toHaveLength(0);
  });

  it('keeps cardio units apart — "8 km" never beats a "5 mi" best', () => {
    const prs = computePeriodPRs(
      [],
      [
        makeCardio('2026-04-01', 'Trail Run', '5 mi', null),
        makeCardio('2026-05-20', 'Trail Run', '6 mi', null),
        makeCardio('2026-05-25', 'Trail Run', '8 km', null),
      ],
      MONTH,
    );
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ kind: 'distance', unit: 'mi', value: 6 });
  });

  it('detects elevation PRs independently of distance', () => {
    const prs = computePeriodPRs(
      [],
      [
        makeCardio('2026-04-01', 'Hike', '4 mi', '800 ft'),
        makeCardio('2026-05-20', 'Hike', '3 mi', '1,200 ft'),
      ],
      MONTH,
    );
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ kind: 'elevation', unit: 'ft', value: 1200, previousValue: 800 });
  });
});

describe('computeReviewStats', () => {
  it('sums tonnage from parseable weighted sets only', () => {
    const stats = computeReviewStats(
      inputs({
        setLogs: [
          makeSet('2026-05-20', 'Bench Press', '185lb', '5'),
          makeSet('2026-05-20', 'Bench Press', 'BW', '10'), // unparseable weight → reps-only
          makeSet('2026-05-21', 'Squat', '84 kg', '5'),
          makeSet('2026-05-22', 'Deadlift', '200', '3', { is_autofilled: true }), // skipped set
          makeSet('2026-04-01', 'Row', '100', '10'), // outside period
        ],
      }),
    );
    expect(stats.strength.tonnage).toBe(185 * 5 + 84 * 5);
    expect(stats.strength.totalSets).toBe(3); // two lifts + the BW reps set
    expect(stats.strength.totalReps).toBe(5 + 10 + 5);
    expect(stats.strength.heaviestSet).toMatchObject({ weight: 185, exerciseName: 'Bench Press' });
  });

  it('sums cardio per unit without converting', () => {
    const stats = computeReviewStats(
      inputs({
        cardioLogs: [
          makeCardio('2026-05-20', 'Trail Run', '5 mi', '800 ft'),
          makeCardio('2026-05-27', 'Trail Run', '6.2 mi', '1,000 ft'),
          makeCardio('2026-06-01', 'Bike', '20 km', null),
        ],
      }),
    );
    expect(stats.cardio.distanceByUnit).toEqual({ mi: 11.2, km: 20 });
    expect(stats.cardio.elevationByUnit).toEqual({ ft: 1800 });
    // Highlight comes from the dominant (most-logged) unit: mi.
    expect(stats.cardio.longestDistance).toMatchObject({ value: 6.2, unit: 'mi' });
  });

  it('counts sessions, active days, weeks, and streaks from completions', () => {
    const stats = computeReviewStats(
      inputs({
        completions: [
          makeCompletion('2026-05-18', 'weights'),
          makeCompletion('2026-05-19', 'yoga'),
          makeCompletion('2026-05-20', 'weights'),
          makeCompletion('2026-05-20', 'stretching'), // same day, second session
          makeCompletion('2026-06-01', 'cardio'),
          makeCompletion('2026-05-01', 'weights', { event_date: '2026-05-01' }), // outside period
        ],
      }),
    );
    expect(stats.totals.sessionsCompleted).toBe(5);
    expect(stats.totals.sessionsByType).toEqual({ weights: 2, yoga: 1, stretching: 1, cardio: 1 });
    expect(stats.totals.activeDays).toBe(4);
    expect(stats.totals.weeksActive).toBe(2);
    expect(stats.streaks.longestActiveDayStreak).toBe(3);
    expect(stats.streaks.mostActiveWeek).toMatchObject({ weekStart: '2026-05-18', sessions: 4 });
  });

  it('prefers tracked session time over completion estimates', () => {
    const completion = makeCompletion('2026-05-20', 'weights', { duration_minutes: 60 });
    const stats = computeReviewStats(
      inputs({
        completions: [completion],
        sessions: [makeSession('2026-05-20', completion.event_id, 90 * 60)],
      }),
    );
    expect(stats.totals.totalDurationMinutes).toBe(90);
    expect(stats.notable.longestSession).toMatchObject({ minutes: 90, title: 'weights session' });
  });
});

describe('computeYearlyStats', () => {
  it('buckets months across a 53-week year and picks retrospective winners', () => {
    const yearInputs = inputs({
      period: YEAR,
      completions: [
        // Month 1 (Dec 29 2025 – Jan 25 2026):
        makeCompletion('2025-12-30', 'weights'),
        makeCompletion('2026-01-05', 'weights'),
        // Month 6 (May 18 – Jun 14): 3 sessions → best month
        makeCompletion('2026-05-18', 'climbing'),
        makeCompletion('2026-05-25', 'climbing'),
        makeCompletion('2026-06-01', 'weights'),
        // Month 13 week 53 (Dec 28 2026 – Jan 3 2027):
        makeCompletion('2026-12-30', 'climbing'),
        makeCompletion('2027-01-02', 'climbing'),
      ],
      setLogs: [
        makeSet('2026-01-05', 'Bench Press', '100', '5'),
        makeSet('2026-05-18', 'Bench Press', '110', '5'),
      ],
    });
    const stats = computeYearlyStats(yearInputs);

    expect(stats.months).toHaveLength(13);
    expect(stats.months[0].sessions).toBe(2);
    expect(stats.months[5].sessions).toBe(3);
    // Week-53 days land in month 13, including the January 2027 spillover.
    expect(stats.months[12].sessions).toBe(2);
    expect(stats.months[5].prCount).toBe(1);
    expect(stats.bestMonth?.monthIndex).toBe(6);
    expect(stats.bestCategory).toEqual({ type: 'climbing', sessions: 4 });
    // climbing: 2 sessions in months 1–7, 2 in months 8–13 → no improvement;
    // nothing else grew either.
    expect(stats.mostImprovedCategory).toBeNull();
    expect(stats.biggestPRs).toHaveLength(1);
  });

  it('breaks best-month ties by total duration', () => {
    const stats = computeYearlyStats(
      inputs({
        period: YEAR,
        completions: [
          makeCompletion('2026-01-05', 'weights', { duration_minutes: 30 }),
          makeCompletion('2026-05-18', 'weights', { duration_minutes: 90 }),
        ],
      }),
    );
    expect(stats.bestMonth?.monthIndex).toBe(6);
  });

  it('finds the most improved category across halves', () => {
    const stats = computeYearlyStats(
      inputs({
        period: YEAR,
        completions: [
          makeCompletion('2026-01-05', 'climbing'), // month 1 (H1)
          makeCompletion('2026-08-18', 'climbing'), // month 9 (H2)
          makeCompletion('2026-09-01', 'climbing'), // month 10 (H2)
          makeCompletion('2026-02-02', 'weights'), // steady
          makeCompletion('2026-08-19', 'weights'),
        ],
      }),
    );
    expect(stats.mostImprovedCategory).toEqual({ type: 'climbing', firstHalf: 1, secondHalf: 2 });
  });

  it('collects memorable candidates deterministically', () => {
    const completion = makeCompletion('2026-05-18', 'weights');
    const stats = computeYearlyStats(
      inputs({
        period: YEAR,
        completions: [completion],
        sessions: [makeSession('2026-05-18', completion.event_id, 80 * 60, 'Strong pull day. Bench moved well.')],
        setLogs: [
          makeSet('2026-01-05', 'Bench Press', '100', '5'),
          makeSet('2026-01-05', 'Squat', '120', '5'),
          makeSet('2026-05-18', 'Bench Press', '110', '5'),
          makeSet('2026-05-18', 'Squat', '130', '5'),
        ],
        cardioLogs: [
          makeCardio('2026-03-02', 'Trail Run', '10 mi', '2,000 ft'),
        ],
      }),
    );
    const joined = stats.memorableCandidates.join('\n');
    expect(joined).toContain('2 PRs in one day: Bench Press, Squat');
    expect(joined).toContain('Longest distance: 10 mi (Trail Run)');
    expect(joined).toContain('Biggest climb: 2000 ft elevation (Trail Run)');
    expect(joined).toContain('Longest session: 80 min');
    expect(joined).toContain('Coach note, May 18');
  });
});
