import type { WorkoutEvent } from '../../src/types/workout';

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
