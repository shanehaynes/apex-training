import type { WorkoutEvent } from '../../src/types/workout';
import type { CardioLogInput, PhysiologyInputs } from '../../src/lib/physiology/index';

// Builders for case fixtures. Defaults keep case files terse.

let fixtureEventCounter = 0;

export function makeEvent(overrides: Partial<WorkoutEvent> & { date: string; title: string }): WorkoutEvent {
  fixtureEventCounter += 1;
  return {
    id: `fix-${fixtureEventCounter}`,
    type: 'weights',
    estimatedDuration: 60,
    description: '',
    exercises: [],
    difficulty: 3,
    tags: [],
    isCompleted: false,
    isRecurring: false,
    ...overrides,
  };
}

export function resetFixtureIds(): void {
  fixtureEventCounter = 0;
}

/** One hand-entered cardio session for the physiology panel. */
export interface CardioSession {
  date: string;
  minutes: number;
  /** Average heart rate; the zone it lands in is decided by thresholdHr. */
  avgHr: number;
}

/**
 * A small PhysiologyInputs: cardio logs only (no synced streams, no set
 * logs), classed by average HR against a lactate-threshold HR — the
 * coarsest path computePhysiology takes, and the one a hand-logging athlete
 * gets. With thresholdHr 160, Z2 is 136–143 bpm (Friel LTHR bands, 85–90%
 * of threshold); 140 is a safe Z2 average, 165 a Z5 one. `today` should be
 * the case's own date; the harness overrides it with fixture.today anyway.
 */
export function makePhysiology(
  today: string,
  sessions: CardioSession[],
  thresholdHr = 160,
): PhysiologyInputs {
  const cardioLogs: CardioLogInput[] = sessions.map((s, i) => ({
    eventId: `fix-cardio-${i + 1}`,
    eventDate: s.date,
    avgHeartRate: s.avgHr,
    durationMinutes: s.minutes,
  }));
  return { today, activities: [], cardioLogs, setLogs: [], thresholdHr, maxHr: null };
}
