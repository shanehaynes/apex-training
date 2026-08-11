import { describe, it, expect } from 'vitest';
import { matchActivity, occurrenceKey, type MatchableActivity } from '../matching';
import type { WorkoutEvent } from '../../../types/workout';

function occ(overrides: Partial<WorkoutEvent>): WorkoutEvent {
  return {
    id: 'evt-1',
    type: 'cardio',
    title: 'Morning Run',
    date: '2026-08-10',
    estimatedDuration: 45,
    description: '',
    exercises: [],
    difficulty: 3,
    tags: [],
    isCompleted: false,
    isRecurring: false,
    ...overrides,
  } as WorkoutEvent;
}

const run: MatchableActivity = {
  localDate: '2026-08-10',
  startMinutes: 6 * 60 + 32,
  durationMin: 47,
  apexType: 'cardio',
};

const none = new Set<string>();

describe('matchActivity', () => {
  it('matches a same-day planned event of the same type', () => {
    const planned = occ({ id: 'run-1', startTime: '6:30 AM' });
    expect(matchActivity(run, [planned], none, none)).toBe(planned);
  });

  it('returns null when the date differs', () => {
    const planned = occ({ id: 'run-1', date: '2026-08-09' });
    expect(matchActivity(run, [planned], none, none)).toBeNull();
  });

  it('returns null when the type is incompatible', () => {
    const planned = occ({ id: 'lift-1', type: 'weights' });
    expect(matchActivity(run, [planned], none, none)).toBeNull();
  });

  it('widens climbing to outdoor-climbing and back', () => {
    const outdoor = occ({ id: 'climb-1', type: 'outdoor-climbing' });
    const climbActivity: MatchableActivity = { ...run, apexType: 'climbing' };
    expect(matchActivity(climbActivity, [outdoor], none, none)).toBe(outdoor);
  });

  it('never offers a completed occurrence', () => {
    const planned = occ({ id: 'run-1' });
    const completed = new Set([occurrenceKey('run-1', '2026-08-10')]);
    expect(matchActivity(run, [planned], completed, none)).toBeNull();
  });

  it('never offers an already-filled occurrence', () => {
    const planned = occ({ id: 'run-1' });
    const filled = new Set([occurrenceKey('run-1', '2026-08-10')]);
    expect(matchActivity(run, [planned], none, filled)).toBeNull();
  });

  it('prefers the closest start time', () => {
    const early = occ({ id: 'early', startTime: '6:30 AM' });
    const late = occ({ id: 'late', startTime: '6:00 PM' });
    expect(matchActivity(run, [late, early], none, none)).toBe(early);
  });

  it('breaks start-time ties on duration', () => {
    const short = occ({ id: 'short', estimatedDuration: 45 });
    const long = occ({ id: 'long', estimatedDuration: 120 });
    // Neither has a start time — both deltas saturate, duration decides.
    expect(matchActivity(run, [long, short], none, none)).toBe(short);
  });

  it('handles unparseable planned start times without NaN poisoning', () => {
    const weird = occ({ id: 'weird', startTime: 'dawn' });
    expect(matchActivity(run, [weird], none, none)).toBe(weird);
  });

  it('matches recurring occurrence ids (base__date)', () => {
    const planned = occ({ id: 'w1-run__2026-08-10' });
    const match = matchActivity(run, [planned], none, none);
    expect(match?.id).toBe('w1-run__2026-08-10');
  });
});
