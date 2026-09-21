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
// Ramp hues are desaturated and warm-biased to sit on the dark surfaces
// (tokens.css --bg-surface #161412): all clear 5:1 contrast on it — well past
// the 3:1 StreamCharts standard — and stay distinguishable from each other
// under deuteranopia (varied lightness, not just hue).
//
// Slots 1 and 2 are the signal (--positive) and the ink (--text-primary) on
// purpose: a one- or two-series chart then carries no chroma but the chroma
// that means something.

const SERIES_RAMP = [
  '#e8601c', // signal — burnt orange (--positive)
  '#ede8df', // ink (--text-primary)
  '#d4a53a', // ochre
  '#8fae7d', // sage
  '#7d9bb8', // steel
  '#c98a84', // rose
  '#6fa89b', // teal
  '#8f8781', // dim (--text-muted)
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
