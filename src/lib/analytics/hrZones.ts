// ─── Heart-rate zones ────────────────────────────────────────────────────────
// Pure zone math over the synced HR stream ([secondsFromStart, bpm] pairs,
// activity_streams.streams.hr). Two models, per Shane's call:
//   - threshold_hr set → Friel LTHR bands (the zones trained athletes use)
//   - else max_hr set  → classic %-of-max bands
//   - neither          → zones unavailable (the tile explains, engine.ts)
// Zone boundaries are LOWER bounds of Z2–Z5: bpm below bounds[0] is Z1,
// bounds[0] <= bpm < bounds[1] is Z2, …, bpm >= bounds[3] is Z5.

export const ZONE_COUNT = 5;
export const ZONE_LABELS = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5'] as const;

export interface HrSettings {
  maxHr: number | null;
  thresholdHr: number | null;
}

/**
 * Friel run-oriented LTHR bands (Z1 <85%, Z2 85-89%, Z3 90-94%, Z4 95-99%,
 * Z5 >=100% of LTHR) or %-of-max bands (60/70/80/90). Null when neither
 * setting exists.
 */
export function zoneBounds(settings: HrSettings): [number, number, number, number] | null {
  if (settings.thresholdHr != null) {
    const t = settings.thresholdHr;
    return [0.85 * t, 0.90 * t, 0.95 * t, 1.00 * t];
  }
  if (settings.maxHr != null) {
    const m = settings.maxHr;
    return [0.60 * m, 0.70 * m, 0.80 * m, 0.90 * m];
  }
  return null;
}

export function zoneOf(bpm: number, bounds: [number, number, number, number]): number {
  if (bpm >= bounds[3]) return 4;
  if (bpm >= bounds[2]) return 3;
  if (bpm >= bounds[1]) return 2;
  if (bpm >= bounds[0]) return 1;
  return 0;
}

/**
 * Seconds spent in each zone, integrating the sampled stream: each sample's
 * bpm covers the gap to the NEXT sample; the last sample gets the median
 * gap (streams are downsampled evenly, so the median is the honest guess).
 * Non-increasing timestamps and non-finite values are skipped defensively —
 * provider payloads are not under our control.
 */
export function zoneSeconds(
  hr: Array<[number, number]>,
  bounds: [number, number, number, number],
): [number, number, number, number, number] {
  const out: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  const samples = hr.filter(
    (p): p is [number, number] =>
      Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1] > 0,
  );
  if (samples.length === 0) return out;

  const gaps: number[] = [];
  for (let i = 0; i + 1 < samples.length; i++) {
    const dt = samples[i + 1][0] - samples[i][0];
    if (dt > 0) gaps.push(dt);
  }
  const medianGap = gaps.length
    ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
    : 1;

  for (let i = 0; i < samples.length; i++) {
    const dt = i + 1 < samples.length ? samples[i + 1][0] - samples[i][0] : medianGap;
    if (dt <= 0) continue;
    out[zoneOf(samples[i][1], bounds)] += dt;
  }
  return out;
}
