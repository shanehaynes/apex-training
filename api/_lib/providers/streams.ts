// Activity time series, shared by every provider: COROS (its list payload and
// FIT files) and Apple Health (the phone's HR samples). Kept out of the
// calendar read path in activity_streams.streams.

export const MAX_STREAM_POINTS = 2000;

/** Thin a series to ≤ max points, always keeping first and last. */
export function downsample<T>(points: T[], max = MAX_STREAM_POINTS): T[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}
