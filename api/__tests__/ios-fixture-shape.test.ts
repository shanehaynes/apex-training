import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBootstrap } from '../_lib/trackerSession';
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

/** Every key path in a JSON value, array elements merged as `[]`. */
function keyPaths(value: unknown, prefix = ''): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown, p: string) => {
    if (Array.isArray(v)) return v.forEach(x => walk(x, `${p}[]`));
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

// The event is an input here, not under test: it comes from the fixture so the
// `event` and `groups[].exercises[].exercise` subtrees match by construction.
const event = read('bootstrap.json').event as unknown as WorkoutEvent;

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
  return makeAdmin({
    profiles: [{ id: 'u1', weight_unit: 'lb', body_weight_lb: null }],
    exercise_definitions: [{ id: 'ios-fixture-def', user_id: 'u1', canonical_name: 'Fixture Press', category: 'strength', aliases: ['fx press'] }],
    workout_set_logs: [...history, ...saved] as unknown as Record<string, unknown>[],
  });
}

describe('iOS bootstrap fixtures carry exactly the fields the server sends', () => {
  it('bootstrap.json — a finished session, re-opened', async () => {
    const logged = setLog({
      event_id: TRACKED, event_date: DATE, actual_weight: '120 lb', actual_reps: '3', updated_at: '2026-09-22T17:45:00.000Z',
    });
    const boot = await buildBootstrap(admin([logged]), 'u1', finishedSession as WorkoutSessionRow, event);
    expect(boot.prs.map(pr => pr.kind)).toEqual(['oneRM']);
    expectSameShape('bootstrap.json', boot);
  });

  it('bootstrap-peek.json — before the session starts', async () => {
    const boot = await buildBootstrap(admin([]), 'u1', null, event);
    expectSameShape('bootstrap-peek.json', boot);
  });

  it('key paths see through nesting and arrays', () => {
    // Guards the comparison itself: a key-path set that ignored nesting or
    // arrays would pass every fixture.
    expect([...keyPaths({ a: [{ b: 1 }, { c: { d: 2 } }] })].sort()).toEqual(['a', 'a[].b', 'a[].c', 'a[].c.d']);
  });
});
