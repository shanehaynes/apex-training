import { describe, it, expect } from 'vitest';
import { loadAnalyticsInputs } from '../_lib/analyticsData';
import { canonicalNameOf } from '../../src/lib/schedule/definitions';
import { makeCardio, makeSet } from '../../src/lib/analytics/__tests__/helpers';

// The loader over a fake admin chain — the analytics-compute.test.ts builder
// plus the .range slicing fetchAllPages drives. What is pinned here is its
// contract with the engine (issue #101): the definitions query carries the
// NAME columns, the alias index comes back on the inputs, and the log rows
// do NOT — they reach the engine exactly as they were logged.

type Admin = Parameters<typeof loadAnalyticsInputs>[0];

interface Query { table: string; select: string; range: [number, number] | null }

function makeAdmin(rows: Record<string, unknown[]>, queries: Query[] = []): Admin {
  return {
    from(table: string) {
      const query: Query = { table, select: '', range: null };
      queries.push(query);
      const data = rows[table] ?? [];
      let from = 0;
      let to = data.length - 1;
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const method of ['eq', 'gte', 'lt', 'order']) builder[method] = chain;
      builder.select = (columns: string) => { query.select = columns; return builder; };
      builder.range = (f: number, t: number) => { from = f; to = t; query.range = [f, t]; return builder; };
      builder.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: data.slice(from, to + 1), error: null }).then(resolve);
      return builder;
    },
  } as unknown as Admin;
}

const WINDOW = { startDate: '2026-09-01', endDateExclusive: '2026-10-01' };
const OPTS = { withHrZones: false, hr: { maxHr: null, thresholdHr: null } };

const definitions = [
  { id: 'def-press', category: 'strength', canonical_name: 'Fixture Press', aliases: ['fx press'] },
  { id: 'def-run', category: 'cardio', canonical_name: 'Morning Run', aliases: null },
];

describe('loadAnalyticsInputs', () => {
  it('selects the name columns and returns an index the engine resolves names through', async () => {
    const queries: Query[] = [];
    const inputs = await loadAnalyticsInputs(
      makeAdmin({ exercise_definitions: definitions }, queries), 'user-123', WINDOW, OPTS,
    );

    const defs = queries.find(q => q.table === 'exercise_definitions')!;
    expect(defs.select).toContain('canonical_name');
    expect(defs.select).toContain('aliases');
    // The same query still feeds the category map that identifies pitch rows.
    expect(inputs.categories.get('def-press')).toBe('strength');

    expect(inputs.aliasIndex).toBeDefined();
    expect(canonicalNameOf('fx press', inputs.aliasIndex!)).toBe('Fixture Press');
    expect(canonicalNameOf('FX   Press', inputs.aliasIndex!)).toBe('Fixture Press');
    // A definition with no aliases still maps its own spelling…
    expect(canonicalNameOf('morning run', inputs.aliasIndex!)).toBe('Morning Run');
    // …and a name no definition claims passes straight through.
    expect(canonicalNameOf('Bench Press', inputs.aliasIndex!)).toBe('Bench Press');
  });

  it('hands the log rows over as logged, never rewritten', async () => {
    const inputs = await loadAnalyticsInputs(makeAdmin({
      exercise_definitions: definitions,
      workout_set_logs: [makeSet('2026-09-08', 'fx press', '100', '5')],
      workout_cardio_logs: [makeCardio('2026-09-08', 'am run', '5 mi', null)],
    }), 'user-123', WINDOW, OPTS);

    // Canonicalizing here would break the other direction — a tile saved with
    // the alias spelling would stop matching — so the engine resolves instead.
    expect(inputs.setLogs.map(r => r.exercise_name)).toEqual(['fx press']);
    expect(inputs.cardioLogs.map(r => r.exercise_name)).toEqual(['am run']);
  });

  it("drains past PostgREST's 1000-row page", async () => {
    const setLogs = Array.from({ length: 1001 }, (_, i) => makeSet('2026-09-08', 'fx press', '100', String((i % 8) + 1)));
    const queries: Query[] = [];
    const inputs = await loadAnalyticsInputs(
      makeAdmin({ exercise_definitions: definitions, workout_set_logs: setLogs }, queries), 'user-123', WINDOW, OPTS,
    );

    expect(inputs.setLogs).toHaveLength(1001);
    expect(queries.filter(q => q.table === 'workout_set_logs').map(q => q.range)).toEqual([[0, 999], [1000, 1999]]);
  });
});
