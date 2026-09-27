// ─── Physiology panel: input and output shapes ───────────────────────────────
// The coach's instrument cluster (A02): five weeks of measured data reduced
// to a handful of pre-computed numbers. The *Input shapes are the minimal
// plain projections of activity_streams, workout_cardio_logs and
// workout_set_logs that the computation needs — the server fetch
// (api/_lib/coach/physiology.ts) maps rows onto them, tests build them by
// hand. Nothing here imports React, supabase-js or a browser global: every
// file under src/lib/physiology/ is reachable from api/**.

/** One synced activity (activity_streams row), summary scalars only. */
export interface ActivityInput {
  eventId: string;
  /** YYYY-MM-DD, the calendar day the activity is filed under. */
  eventDate: string;
  durationSec: number | null;
  avgHr: number | null;
  /**
   * summary.hrZones exactly as the provider sent it. COROS passes it through
   * summaryExtras unnormalized, so no shape is pinned anywhere in the repo;
   * compute.ts parses it tolerantly and only trusts a reading whose total
   * agrees with durationSec (see parseHrZones).
   */
  hrZones: unknown;
  /** Provider training-load score for the activity (COROS "Load"). */
  trainingLoad: number | null;
  /** Provider HRV reading attached to the activity, ms. */
  hrv: number | null;
}

/** One workout_cardio_logs row (measured or hand-entered). */
export interface CardioLogInput {
  eventId: string;
  eventDate: string;
  avgHeartRate: number | null;
  durationMinutes: number | null;
}

/** One workout_set_logs row — the free-text tracker values, unparsed. */
export interface SetLogInput {
  eventDate: string;
  actualWeight: string | null;
  actualReps: string | null;
  actualDuration: string | null;
  isAutofilled: boolean;
}

export interface PhysiologyInputs {
  /** YYYY-MM-DD, the athlete's local calendar date. */
  today: string;
  activities: ActivityInput[];
  cardioLogs: CardioLogInput[];
  setLogs: SetLogInput[];
  thresholdHr: number | null;
  maxHr: number | null;
}

/** Minutes in Z1…Z5, in that order. */
export type ZoneMinutes = [number, number, number, number, number];

export interface WeekZoneMinutes {
  /** Monday, YYYY-MM-DD. */
  weekStart: string;
  /** Null when no activity or cardio log in the week yielded a zone reading. */
  minutes: ZoneMinutes | null;
}

export interface WeekTonnage {
  weekStart: string;
  /** Σ weight × reps of logged (non-autofilled) weighted sets; null when none were logged. */
  tonnageLb: number | null;
}

export interface LoadSummary {
  /** Device training load when any activity carries one, else cardio minutes. */
  source: 'trainingLoad' | 'cardioMinutes';
  /** Sum over the last 7 days, today included. */
  acute7d: number;
  /** Sum over the last 28 days divided by 4. */
  chronicWeeklyAvg28d: number;
  /** acute7d / chronicWeeklyAvg28d; null when there is no chronic baseline. */
  ratio: number | null;
}

export interface HrvSummary {
  /** Mean of readings in the last 7 days; null when none. */
  mean7d: number | null;
  /** Mean of readings in the last 28 days. */
  mean28d: number;
}

/**
 * How the zone minutes were obtained. 'device' — every contributing session
 * had provider zone data; 'avgHr' — every one was a whole session classed by
 * its average HR (coarse: one zone per session); 'mixed' — some of each.
 */
export type ZoneMethod = 'device' | 'avgHr' | 'mixed';

export interface PhysiologySummary {
  /** Five Monday dates, oldest first; the last is the current week. */
  weekStarts: string[];
  today: string;
  zoneMinutesByWeek?: WeekZoneMinutes[];
  zoneMethod?: ZoneMethod;
  load?: LoadSummary;
  tonnageByWeek?: WeekTonnage[];
  hrv?: HrvSummary;
}
