import { describe, it, expect } from 'vitest';
import { seriesColors } from '../palette';
import { WORKOUT_COLORS } from '../../../utils/workoutColors';
import type { RenderedSeries } from '../engine';

// The colour rule the iOS port mirrors (ApexCore SeriesColors, W9): these
// vectors are copied verbatim into SeriesColorsTests, so a change here is a
// change there.

const RAMP = ['#f97316', '#38bdf8', '#4ade80', '#facc15', '#c084fc', '#fb7185', '#2dd4bf', '#a3a3a3'];

const series = (...keys: string[]): RenderedSeries[] =>
  keys.map(key => ({ key, label: key, unitKind: 'count', unit: '', axis: 'left', points: [] }));

describe('seriesColors', () => {
  it('walks the ramp by position for plain series', () => {
    expect(seriesColors(series('s1'))).toEqual([RAMP[0]]);
    expect(seriesColors(series('s1', 's2', 's3'))).toEqual([RAMP[0], RAMP[1], RAMP[2]]);
  });

  it('gives a workout-type group its app colour', () => {
    expect(seriesColors(series('s1:weights', 's1:cardio'))).toEqual([
      WORKOUT_COLORS.weights.border,
      WORKOUT_COLORS.cardio.border,
    ]);
  });

  it('does not let a workout-type group consume a ramp slot', () => {
    expect(seriesColors(series('s1', 's2:weights', 's3'))).toEqual([RAMP[0], WORKOUT_COLORS.weights.border, RAMP[1]]);
  });

  it('wraps the ramp after eight plain series', () => {
    const nine = seriesColors(series(...Array.from({ length: 9 }, (_, i) => `s${i + 1}`)));
    expect(nine[8]).toBe(RAMP[0]);
    expect(nine.slice(0, 8)).toEqual(RAMP);
  });

  it('treats a group that is not a workout type as a plain series', () => {
    expect(seriesColors(series('s1:running', 's1:biking'))).toEqual([RAMP[0], RAMP[1]]);
  });
});
