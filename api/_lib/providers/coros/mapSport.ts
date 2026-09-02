// COROS sport → Apex workout type + display label. The workout_events.type
// CHECK set is small (phase17), so most endurance sports collapse into
// 'cardio' with the sport preserved in the event title and the
// activity_streams summary. Accepts either a label string ("Trail Run")
// or a numeric COROS sport code; unknowns fall back to cardio so a new
// watch mode never blocks an import.

export type ApexWorkoutType =
  | 'stretching' | 'morning-routine' | 'weights'
  | 'climbing' | 'outdoor-climbing' | 'cardio' | 'yoga';

/** The analytics sport bucket (phase 37); null = no bucket (ski, row, walk…). */
export type ActivitySport = 'running' | 'biking' | 'swimming' | 'climbing' | null;

export interface SportMapping {
  type: ApexWorkoutType;
  /** Human sport name used as the event title, e.g. "Trail Run". */
  label: string;
  /** Stamped onto created events so synced history joins the sport breakdown. */
  sport: ActivitySport;
}

// The official dubbo sport-type table, verified 2026-08-10 against the live
// querySportRecords tool description (frozen in
// api/__tests__/fixtures/coros/tools-list.json). Fishing (707-715), ball
// sports, and custom modes deliberately stay unlisted — they fall through
// to "Activity <code>" + cardio, which is the right import for anything
// Apex has no native type for.
const CODE_LABELS: Record<number, string> = {
  100: 'Run',
  101: 'Indoor Run',
  102: 'Trail Run',
  103: 'Track Run',
  104: 'Hike',
  105: 'Mountain Climb',       // vertical hiking mode, not rock climbing
  106: 'Multi-Pitch Climb',
  200: 'Bike',
  201: 'Indoor Bike',
  202: 'E-Bike',
  203: 'Gravel Bike',
  204: 'Mountain Bike',
  205: 'Mountain E-Bike',
  299: 'Bike',
  300: 'Pool Swim',
  301: 'Open Water Swim',
  400: 'Gym Cardio',
  401: 'GPS Cardio',
  402: 'Strength',
  500: 'Ski',
  501: 'Snowboard',
  502: 'XC Ski',
  503: 'Alpine Touring',
  700: 'Rowing',
  701: 'Indoor Row',
  702: 'Whitewater',
  704: 'Flatwater',
  705: 'Windsurfing',
  706: 'Speedsurfing',
  800: 'Indoor Climb',
  801: 'Bouldering',
  802: 'Outdoor Climb',
  900: 'Walk',
  901: 'Jump Rope',
  902: 'Stair Climbing',
  903: 'Elliptical',
  904: 'Yoga',
  905: 'Pilates',
  906: 'Boxing',
  1200: 'Hybrid Fitness',
  10000: 'Triathlon',
  10002: 'Climb Ski',
  10003: 'Multi-Pitch Climb',
};

const LABEL_RULES: Array<{ pattern: RegExp; type: ApexWorkoutType }> = [
  // Order matters: indoor climbing before the outdoor-climb catch, and
  // nothing here may match "Stair Climbing" or "Mountain Climb" (both
  // endurance modes that belong in cardio).
  { pattern: /boulder|indoor.?climb|gym.?climb/i, type: 'climbing' },
  { pattern: /outdoor.?climb|rock.?climb|sport.?climb|trad|multi.?pitch/i, type: 'outdoor-climbing' },
  { pattern: /strength|weight|lift/i, type: 'weights' },
  { pattern: /yoga/i, type: 'yoga' },
  { pattern: /stretch|mobility|pilates/i, type: 'stretching' },
  // Everything endurance-shaped — run, ride, hike, ski, swim, row, walk —
  // and any unmatched label lands in cardio via the default below.
];

function titleCase(raw: string): string {
  return raw
    .replaceAll(/[_-]+/g, ' ')
    .trim()
    .replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// The five-bucket sport, from the label. Everything unmatched stays null —
// 'other' is reserved for workouts the user deliberately names, never a
// dumping ground for unmapped watch modes. Order-safe against the traps the
// type rules dodge ("Stair Climbing", "Mountain Climb"): climbing comes
// from the resolved TYPE, not a label pattern.
const SPORT_RULES: Array<{ pattern: RegExp; sport: ActivitySport }> = [
  { pattern: /\brun\b/i, sport: 'running' },
  { pattern: /bike|cycl/i, sport: 'biking' },
  { pattern: /swim/i, sport: 'swimming' },
];

export function mapSport(sport: string | number | undefined | null): SportMapping {
  const label = typeof sport === 'number'
    ? CODE_LABELS[sport] ?? `Activity ${sport}`
    : sport?.trim()
      ? titleCase(sport)
      : 'Activity';

  const rule = LABEL_RULES.find(r => r.pattern.test(label));
  const type = rule?.type ?? 'cardio';
  const bucket = type === 'climbing' || type === 'outdoor-climbing'
    ? 'climbing'
    : SPORT_RULES.find(r => r.pattern.test(label))?.sport ?? null;
  return { type, label, sport: bucket };
}
