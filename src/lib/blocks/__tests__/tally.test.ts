import { describe, expect, it } from 'vitest';
import { tallySessions } from '../progress';

// The one tally behind both what a block's weeks did (completions) and what
// its calendar implies (planned events).

describe('tallySessions', () => {
  it('is all zeros for no sessions', () => {
    expect(tallySessions([])).toEqual({
      cardioMinutes: 0, strengthSessions: 0, climbingSessions: 0, longestSessionMinutes: 0,
    });
  });

  it('adds minutes only for cardio sessions, and counts strength and both climbing types', () => {
    expect(tallySessions([
      { type: 'cardio', minutes: 45 },
      { type: 'cardio', minutes: 30 },
      { type: 'weights', minutes: 60 },
      { type: 'climbing', minutes: 90 },
      { type: 'outdoor-climbing', minutes: 240 },
      { type: 'mobility', minutes: 20 },
    ])).toEqual({
      cardioMinutes: 75,
      strengthSessions: 1,
      climbingSessions: 2,
      longestSessionMinutes: 240, // the long day counts whatever its type
    });
  });

  it('takes the longest session, not a sum, and a zero-minute session counts but adds nothing', () => {
    const tally = tallySessions([
      { type: 'weights', minutes: 0 },
      { type: 'cardio', minutes: 50 },
      { type: 'cardio', minutes: 80 },
    ]);
    expect(tally.longestSessionMinutes).toBe(80);
    expect(tally.strengthSessions).toBe(1);
    expect(tally.cardioMinutes).toBe(130);
  });
});
