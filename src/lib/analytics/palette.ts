import { WORKOUT_COLORS } from '../../utils/workoutColors';
import type { WorkoutType } from '../../types/workout';
import type { RenderedSeries } from './engine';

// ─── Series colors ───────────────────────────────────────────────────────────
// Multi-series tiles need identity colors (StreamCharts' single-mark rule
// covers single-series charts only). Event-type groups reuse the app's
// workout color language so "weights" is the same orange everywhere; every
// other series draws from a fixed 8-color ramp, assigned deterministically
// by position so a tile's colors never reshuffle between renders.
//
// Ramp hues are picked against the dark surfaces (tokens.css --bg-surface
// #161412): all sit in the mid-lightness band that clears 3:1 contrast on
// it — the StreamCharts standard — and stay distinguishable from each other
// under deuteranopia (varied lightness, not just hue).

const SERIES_RAMP = [
  '#f97316', // orange — the house accent
  '#38bdf8', // sky
  '#4ade80', // green
  '#facc15', // yellow
  '#c084fc', // violet
  '#fb7185', // rose
  '#2dd4bf', // teal
  '#a3a3a3', // neutral
] as const;

const WORKOUT_TYPE_KEYS = Object.keys(WORKOUT_COLORS) as WorkoutType[];

function isWorkoutType(value: string): value is WorkoutType {
  return (WORKOUT_TYPE_KEYS as string[]).includes(value);
}

/** The group value a rendered series was fanned out on, or null. */
function groupOf(series: RenderedSeries): string | null {
  const i = series.key.indexOf(':');
  return i === -1 ? null : series.key.slice(i + 1);
}

/**
 * Color per rendered series, in render order. Workout-type groups keep their
 * app color; everything else walks the ramp (skipping any ramp slot a
 * workout color already claimed nearby is not attempted — identity beats
 * novelty, and adjacent tiles reuse the same assignment rules).
 */
export function seriesColors(series: RenderedSeries[]): string[] {
  let rampIndex = 0;
  return series.map(s => {
    const group = groupOf(s);
    if (group && isWorkoutType(group)) return WORKOUT_COLORS[group].border;
    const color = SERIES_RAMP[rampIndex % SERIES_RAMP.length];
    rampIndex += 1;
    return color;
  });
}
