import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBootstrap, loadResolvedOccurrence } from '../_lib/trackerSession';
import type { Tables } from '../../src/lib/db/database.types';
import type { WorkoutSessionRow } from '../../src/lib/db/types';
import type { WorkoutEvent } from '../../src/types/workout';

// The iOS app decodes ios/Fixtures/bootstrap*.json, and only the integration
// suite (ios-read.integration.test.ts) proves those files are what the server
// sends — it needs the local stack, so agent:check skips it and drift was
// first seen in CI (#417, #419, #422: each added a field). This is the no-DB
// half: the same scenario through buildBootstrap on a fake client, compared by
// FIELD NAMES only. Values stay the integration suite's job.

const REGENERATE = 'npm run fixtures:ios';
const FIXTURE_DIR = join(__dirname, '..', '..', 'ios', 'Fixtures');

type Admin = Parameters<typeof buildBootstrap>[0];

/** A chainable fake applying eq / lt / in filters (tracker-percent.test.ts). */
function makeAdmin(fixtures: Record<string, Record<string, unknown>[]>): Admin {
  return {
    from(table: string) {
      const filters: ((row: Record<string, unknown>) => boolean)[] = [];
      const rows = () => (fixtures[table] ?? []).filter(row => filters.every(f => f(row)));
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const m of ['select', 'order', 'range', 'not', 'is', 'gte', 'lte']) builder[m] = chain;
      builder.eq = (column: string, value: unknown) => {
        filters.push(row => column === 'user_id' || row[column] === value);
        return builder;
      };
      builder.lt = (column: string, value: string) => {
        filters.push(row => String(row[column]) < value);
        return builder;
      };
      builder.in = (column: string, values: unknown[]) => {
        filters.push(row => values.includes(row[column]));
        return builder;
      };
      builder.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve);
      return builder;
    },
  } as unknown as Admin;
}

const read = (name: string) => JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as Record<string, unknown>;

const kindOf = (x: unknown) =>
  x && typeof x === 'object' && typeof (x as { kind?: unknown }).kind === 'string' ? `kind=${(x as { kind: string }).kind}` : '';

/** Every key path in a JSON value, array elements merged as `[]` (or `[kind=…]`). */
function keyPaths(value: unknown, prefix = ''): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown, p: string) => {
    // Elements of a tagged union (prs[]) are keyed by their kind, so a field
    // dropped from one kind is not hidden by a sibling kind that has it.
    if (Array.isArray(v)) return v.forEach(x => walk(x, `${p}[${kindOf(x)}]`));
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        const path = p ? `${p}.${k}` : k;
        out.add(path);
        walk(x, path);
      }
    }
  };
  walk(value, prefix);
  return out;
}

function expectSameShape(name: string, built: unknown) {
  // JSON round-trip: undefined-valued keys never reach the wire.
  const actual = keyPaths(JSON.parse(JSON.stringify(built)));
  const committed = keyPaths(read(name));
  const added = [...actual].filter(p => !committed.has(p)).sort();
  const missing = [...committed].filter(p => !actual.has(p)).sort();
  expect(
    { added, missing },
    `ios/Fixtures/${name} no longer matches the bootstrap's fields — regenerate it with \`${REGENERATE}\` and commit`,
  ).toEqual({ added: [], missing: [] });
}

// The integration suite's scenario: Fixture Press 2×5 @ 100 lb, last done
// 09-08 (100×5, 110×3); on 09-22 set 1 is logged at 120×3 — a 1RM PR.
const TRACKED = 'ios-fixture-weekly__2026-09-22';
const DATE = '2026-09-22';

// The base event and the library definition, as full DB rows: a new column on
// either fails tsc here, and loadResolvedOccurrence maps them exactly as the
// handler does, so the `event` subtree is checked too.
const eventRow: Tables<'workout_events'> = {
  id: 'ios-fixture-weekly', user_id: 'u1', title: 'Fixture Push Day', subtitle: null, type: 'weights', sport: null,
  date: '2026-09-01', start_time: '17:30', end_time: '18:30', estimated_duration: 60, difficulty: 3,
  description: 'W0 fixture', location: null, tags: ['fixture'], equipment: [], cover_image_url: null,
  is_recurring: true, recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20261027',
  recurring_days: null, recurring_end_date: null, recurring_frequency: null,
  warmup: [], cooldown: [], cardio_targets: null, climbing_targets: null,
  exercises: [
    { id: 'fx-press', name: 'fx press', definitionId: 'ios-fixture-def', category: 'strength', sets: 2, reps: '5', weight: '100 lb', restPeriod: '2 min' },
    { id: 'fx-row', name: 'Fixture Row', category: 'cardio', duration: '20 min' },
  ],
  template_id: null, scoring_type: null, time_cap_minutes: null, source: null,
  created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
};

const definition: Tables<'exercise_definitions'> = {
  id: 'ios-fixture-def', user_id: 'u1', canonical_name: 'Fixture Press', category: 'strength',
  aliases: ['fx press'], muscle_groups: ['chest'], equipment: ['barbell'], is_unilateral: false,
  archived_at: null, default_duration: null, default_reps: null, default_rest: null, default_sets: null,
  default_weight: null, image_url: null, log_fields: [], technique_notes: null,
  created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
};

/** A full DB row: a new set-log column fails tsc here before it can be missed. */
function setLog(over: Partial<Tables<'workout_set_logs'>>): Tables<'workout_set_logs'> {
  return {
    id: 'set', user_id: 'u1', event_id: 'ios-fixture-weekly__2026-09-08', event_date: '2026-09-08',
    section: 'exercise', exercise_id: 'fx-press', exercise_name: 'Fixture Press', definition_id: 'ios-fixture-def',
    set_number: 1, planned_weight: '100 lb', planned_reps: '5', planned_duration: null,
    actual_weight: '100 lb', actual_reps: '5', actual_duration: null, is_autofilled: false,
    rpe: null, is_warmup: false, ascent_style: null, attempts: null, updated_at: '2026-09-08T18:00:00.000Z',
    ...over,
  };
}

// Typed against the generated row, not WorkoutSessionRow (whose note and
// user_id are optional): a migration adding a column to workout_sessions
// fails tsc here, and once the column is added below this test fails until
// bootstrap.json carries it — the #417 path, a `select('*')` gaining a key.
const finishedSession: Tables<'workout_sessions'> = {
  id: 'session', user_id: 'u1', event_id: TRACKED, event_date: DATE,
  started_at: '2026-09-22T17:30:00.000Z', finished_at: '2026-09-22T18:00:00.000Z',
  total_duration_seconds: 1800, updated_at: '2026-09-22T18:00:00.000Z', coach_summary: null,
  template_id: null, score_type: null, score_time_seconds: null, score_rounds: null, score_reps: null,
  note: null,
};

const history = [
  setLog({}),
  setLog({ set_number: 2, actual_weight: '110 lb', actual_reps: '3' }),
];

function admin(saved: Tables<'workout_set_logs'>[]) {
  const client = makeAdmin({
    profiles: [{ id: 'u1', weight_unit: 'lb', body_weight_lb: null }],
    workout_events: [eventRow],
    exercise_definitions: [definition],
    workout_set_logs: [...history, ...saved] as unknown as Record<string, unknown>[],
  } as unknown as Record<string, Record<string, unknown>[]>);
  return client;
}

async function occurrence(client: Admin): Promise<WorkoutEvent> {
  const event = await loadResolvedOccurrence(client, 'u1', TRACKED, DATE);
  expect(event).not.toBeNull();
  return event!;
}

// bootstrap-full.json: the integration suite's "Mixed Day" — a scored
// for-time event whose finished session reaches every optional branch the two
// fixtures above leave null or absent.
const MIXED = 'ios-fixture-mixed';
const MIXED_DAY = '2026-12-08';
const PRIOR = 'ios-fixture-mixed-prior';
const PRIOR_DAY = '2026-12-01';
const ADDED = 'added-1765000000000';

const mixedEventRow: Tables<'workout_events'> = {
  ...eventRow, id: MIXED, title: 'Mixed Day', date: MIXED_DAY, start_time: '07:00', end_time: null,
  description: 'Every tracker branch at once.', is_recurring: false, recurrence_rule: null,
  template_id: 'ios-fixture-template', scoring_type: 'for-time',
  exercises: [
    { id: 'mx-squat', name: 'Mixed Squat', category: 'strength', sets: 2, reps: '5', weight: '80%' },
    { id: 'mx-plank', name: 'Mixed Plank', category: 'strength', duration: '60 s' },
    { id: 'mx-hang', name: 'Mixed Hang', category: 'strength', duration: '30 s' },
    { id: 'mx-pullup', name: 'Mixed Pull-Up', category: 'strength', sets: 1, reps: '8' },
    { id: 'mx-pitch', name: 'Mixed Arete', category: 'climbing', climbStyle: 'sport', grade: '5.10a' },
    { id: 'mx-bike', name: 'Mixed Bike', category: 'cardio', duration: '30 min' },
    { id: 'mx-ski', name: 'Mixed Ski', category: 'cardio', duration: '10 min' },
  ],
};

const mixedSet = (exercise_id: string, exercise_name: string, over: Partial<Tables<'workout_set_logs'>>) => setLog({
  event_id: MIXED, event_date: MIXED_DAY, exercise_id, exercise_name, definition_id: null,
  planned_weight: null, planned_reps: null, actual_weight: null, actual_reps: null, ...over,
});
const priorSet = (exercise_id: string, exercise_name: string, over: Partial<Tables<'workout_set_logs'>>) =>
  mixedSet(exercise_id, exercise_name, { event_id: PRIOR, event_date: PRIOR_DAY, ...over });

function cardioLog(over: Partial<Tables<'workout_cardio_logs'>>): Tables<'workout_cardio_logs'> {
  return {
    id: 'cardio', user_id: 'u1', event_id: MIXED, event_date: MIXED_DAY, section: 'exercise',
    exercise_id: 'mx-bike', exercise_name: 'Mixed Bike', definition_id: null, duration_minutes: 30,
    distance: null, elevation_gain: null, avg_heart_rate: null, is_autofilled: false,
    updated_at: '2026-12-08T08:00:00.000Z', ...over,
  };
}

const priorSession: Tables<'workout_sessions'> = {
  ...finishedSession, event_id: PRIOR, event_date: PRIOR_DAY, template_id: 'ios-fixture-template',
  score_type: 'for-time', score_time_seconds: 1800,
};
const mixedSession: Tables<'workout_sessions'> = {
  ...finishedSession, event_id: MIXED, event_date: MIXED_DAY, template_id: 'ios-fixture-template',
  score_type: 'for-time', score_time_seconds: 1500, coach_summary: 'Six records in one session.', note: 'Felt strong.',
};

function mixedAdmin() {
  return makeAdmin({
    profiles: [{ id: 'u1', weight_unit: 'lb', body_weight_lb: null }],
    workout_events: [mixedEventRow],
    exercise_definitions: [definition],
    workout_sessions: [priorSession],
    workout_set_logs: [
      priorSet('mx-squat', 'Mixed Squat', { actual_weight: '200 lb', actual_reps: '5' }),
      priorSet('mx-plank', 'Mixed Plank', { actual_duration: '60 s' }),
      priorSet('mx-hang', 'Mixed Hang', { actual_duration: '30 s' }),
      priorSet('mx-pullup', 'Mixed Pull-Up', { actual_reps: '8' }),
      priorSet('mx-pitch', 'Mixed Arete', { actual_weight: '5.9', ascent_style: 'redpoint' }),
      mixedSet('mx-squat', 'Mixed Squat', { actual_weight: '135 lb', actual_reps: '5', is_warmup: true, rpe: 5 }),
      mixedSet('mx-squat', 'Mixed Squat', { set_number: 2, actual_weight: '210 lb', actual_reps: '5', rpe: 8.5 }),
      mixedSet('mx-plank', 'Mixed Plank', { actual_duration: '90 s' }),
      mixedSet('mx-pullup', 'Mixed Pull-Up', { definition_id: 'ios-fixture-def', actual_reps: '10' }),
      mixedSet('mx-pitch', 'Mixed Arete', { actual_weight: '5.10b', ascent_style: 'flash', attempts: 1 }),
      mixedSet(ADDED, 'Mixed Curl', { actual_weight: '30 lb', actual_reps: '10' }),
    ],
    workout_cardio_logs: [
      cardioLog({ event_id: PRIOR, event_date: PRIOR_DAY, distance: '10 mi', elevation_gain: '500 ft', avg_heart_rate: 140 }),
      cardioLog({ event_id: PRIOR, event_date: PRIOR_DAY, exercise_id: 'mx-ski', exercise_name: 'Mixed Ski', duration_minutes: 10, distance: '2 km' }),
      cardioLog({ distance: '12 mi', elevation_gain: '600 ft', avg_heart_rate: 145 }),
    ],
  } as unknown as Record<string, Record<string, unknown>[]>);
}

// bootstrap-amrap.json: the integration suite's AMRAP Day — the other score
// type, which a session row cannot carry alongside for-time.
const AMRAP = 'ios-fixture-amrap';
const AMRAP_DAY = '2026-12-15';

const amrapEventRow: Tables<'workout_events'> = {
  ...eventRow, id: AMRAP, title: 'AMRAP Day', date: AMRAP_DAY, start_time: '07:00', end_time: null,
  estimated_duration: 20, difficulty: 4, description: 'As many rounds as possible.',
  is_recurring: false, recurrence_rule: null,
  template_id: 'ios-fixture-template-amrap', scoring_type: 'amrap', time_cap_minutes: 20,
  exercises: [{ id: 'am-burpee', name: 'AMRAP Burpee', category: 'strength', sets: 1, reps: '10' }],
};
const amrapScore = { template_id: 'ios-fixture-template-amrap', score_type: 'amrap', score_time_seconds: null } as const;
const amrapSession: Tables<'workout_sessions'> = {
  ...finishedSession, ...amrapScore, event_id: AMRAP, event_date: AMRAP_DAY, total_duration_seconds: 1200,
  score_rounds: 6, score_reps: 3,
};
const amrapPrior: Tables<'workout_sessions'> = {
  ...finishedSession, ...amrapScore, event_id: 'ios-fixture-amrap-prior', event_date: '2026-12-10',
  total_duration_seconds: 1200, score_rounds: 5, score_reps: 0,
};

describe('iOS bootstrap fixtures carry exactly the fields the server sends', () => {
  it('bootstrap.json — a finished session, re-opened', async () => {
    const logged = setLog({
      event_id: TRACKED, event_date: DATE, actual_weight: '120 lb', actual_reps: '3', updated_at: '2026-09-22T17:45:00.000Z',
    });
    const client = admin([logged]);
    const boot = await buildBootstrap(client, 'u1', finishedSession as WorkoutSessionRow, await occurrence(client));
    expect(boot.prs.map(pr => pr.kind)).toEqual(['oneRM']);
    expectSameShape('bootstrap.json', boot);
  });

  it('bootstrap-peek.json — before the session starts', async () => {
    const client = admin([]);
    const boot = await buildBootstrap(client, 'u1', null, await occurrence(client));
    expectSameShape('bootstrap-peek.json', boot);
  });

  it('bootstrap-full.json — every optional branch at once', async () => {
    const client = mixedAdmin();
    const event = await loadResolvedOccurrence(client, 'u1', MIXED, MIXED_DAY);
    const boot = await buildBootstrap(client, 'u1', mixedSession as WorkoutSessionRow, event!);
    // The scenario must still reach what it exists to reach, or a missing
    // branch would pass as "no drift".
    expect(boot.scoreRecord?.kind).toBe('workout-score');
    expect(boot.prs.map(pr => pr.kind).sort()).toEqual(['distance', 'duration', 'elevation', 'oneRM', 'reps', 'send']);
    expectSameShape('bootstrap-full.json', boot);
  });

  it('bootstrap-amrap.json — an AMRAP score and its record', async () => {
    const client = makeAdmin({
      workout_events: [amrapEventRow],
      exercise_definitions: [definition],
      workout_sessions: [amrapPrior, {
        ...finishedSession, event_id: 'ios-fixture-amrap-for-time', event_date: '2026-12-12',
        template_id: 'ios-fixture-template-amrap', score_type: 'for-time', score_time_seconds: 900,
      }],
    } as unknown as Record<string, Record<string, unknown>[]>);
    const event = await loadResolvedOccurrence(client, 'u1', AMRAP, AMRAP_DAY);
    const boot = await buildBootstrap(client, 'u1', amrapSession as WorkoutSessionRow, event!);
    expect(boot.scoreRecord).toMatchObject({ kind: 'workout-score', score: { type: 'amrap', rounds: 6, reps: 3 } });
    expectSameShape('bootstrap-amrap.json', boot);
  });

  it('key paths see through nesting and arrays', () => {
    // Guards the comparison itself: a key-path set that ignored nesting or
    // arrays would pass every fixture.
    expect([...keyPaths({ a: [{ b: 1 }, { c: { d: 2 } }] })].sort()).toEqual(['a', 'a[].b', 'a[].c', 'a[].c.d']);
    expect([...keyPaths({ prs: [{ kind: 'a', x: 1 }, { kind: 'b' }] })].sort())
      .toEqual(['prs', 'prs[kind=a].kind', 'prs[kind=a].x', 'prs[kind=b].kind']);
  });
});
