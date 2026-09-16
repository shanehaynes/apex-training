import { describe, it, expect } from 'vitest';
import type { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { getScheduleTool } from '../_lib/mcp/tools/schedule';
import { getExerciseHistoryTool, getPrsTool } from '../_lib/mcp/tools/tracking';
import { searchExercisesTool } from '../_lib/mcp/tools/library';
import { getMealsTool } from '../_lib/mcp/tools/meals';
import { getTrainingBlocksTool } from '../_lib/mcp/tools/blocks';

// Tool-level tests over fixture rows: the plumbing between the service-role
// queries and the pure src/lib computations. No handler/HTTP involved.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

/** max(event_date) per exercise_name per table — the phase31 aggregate. */
function lastPerformedFixture(fixtures: Record<string, unknown[]>) {
  const out: Array<{ exercise_name: string; event_date: string }> = [];
  for (const table of ['workout_set_logs', 'workout_cardio_logs']) {
    const byName = new Map<string, string>();
    for (const row of (fixtures[table] ?? []) as Array<Record<string, unknown>>) {
      if (row.is_autofilled) continue;
      const name = row.exercise_name as string;
      const date = row.event_date as string;
      const seen = byName.get(name);
      if (!seen || date > seen) byName.set(name, date);
    }
    // UNION ALL, not a merge — the caller canonicalizes and folds.
    for (const [name, date] of byName) out.push({ exercise_name: name, event_date: date });
  }
  return out;
}

function makeAdmin(fixtures: Record<string, unknown[]>): Admin {
  return {
    from(table: string) {
      let rows = fixtures[table] ?? [];
      let from = 0;
      let to = rows.length - 1;
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const m of ['select', 'order', 'eq', 'gte', 'lte', 'lt', 'is', 'or']) builder[m] = chain;
      // `.in()` genuinely filters here, unlike the pass-through matchers above:
      // the name-scoped history fetch pushes the exercise filter into the
      // query, so a mock that ignored it would not exercise alias widening.
      builder.in = (column: string, values: unknown[]) => {
        rows = rows.filter(r => values.includes((r as Record<string, unknown>)[column]));
        to = rows.length - 1;
        return builder;
      };
      builder.range = (f: number, t: number) => {
        from = f;
        to = t;
        return builder;
      };
      builder.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
      builder.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows.slice(from, to + 1), error: null }).then(resolve);
      return builder;
    },
    async rpc(fn: string) {
      if (fn !== 'last_performed_by_name') throw new Error(`unmocked rpc: ${fn}`);
      return { data: lastPerformedFixture(fixtures), error: null };
    },
  } as unknown as Admin;
}

const baseEventRow = {
  subtitle: null,
  start_time: null,
  end_time: null,
  estimated_duration: 60,
  description: '',
  warmup: [],
  exercises: [],
  cooldown: [],
  difficulty: null,
  location: null,
  cover_image_url: null,
  cardio_targets: null,
  climbing_targets: null,
  tags: [],
  equipment: [],
  recurring_frequency: null,
  recurring_days: null,
  recurring_end_date: null,
};

describe('get_schedule — recurrence fidelity', () => {
  it('shows a rescheduled occurrence on its override date, not the original', async () => {
    const admin = makeAdmin({
      workout_events: [
        {
          ...baseEventRow,
          id: 'evt-r',
          type: 'weights',
          title: 'Squat Day',
          date: '2026-08-05', // a Wednesday
          is_recurring: true,
          recurrence_rule: 'FREQ=WEEKLY;BYDAY=WE',
        },
      ],
      recurring_exceptions: [
        {
          event_id: 'evt-r',
          skipped_date: '2026-08-12',
          override_date: '2026-08-13',
          override_start_time: null,
          override_end_time: null,
        },
      ],
      exercise_definitions: [],
      workout_completions: [],
    });

    const payload = (await getScheduleTool.run(admin, 'user-123', {
      start_date: '2026-08-01',
      end_date: '2026-08-20',
    })) as { workouts: Array<{ date: string; event_id: string }> };

    const dates = payload.workouts.map(w => w.date);
    expect(dates).toContain('2026-08-05'); // series anchor
    expect(dates).toContain('2026-08-13'); // the moved occurrence
    expect(dates).not.toContain('2026-08-12'); // its original slot is vacated
    // Moved occurrences keep their original-date id (completion state follows).
    const moved = payload.workouts.find(w => w.date === '2026-08-13');
    expect(moved?.event_id).toBe('evt-r__2026-08-12');
  });
});

describe('get_exercise_history — name-scoped fetch', () => {
  // The history query filters by exercise_name in the query rather than
  // draining everything and filtering in JS. The filter is widened to every
  // known spelling, so a rename must not truncate the lineage — that would
  // silently lower the all-time best.
  const renamedFixtures = {
    exercise_definitions: [
      { id: 'bench', canonical_name: 'Bench Press', aliases: ['Barbell Bench'], archived_at: null },
      { id: 'squat', canonical_name: 'Back Squat', aliases: [], archived_at: null },
    ],
    workout_set_logs: [
      // Logged under the FORMER name, and it is the best ever.
      {
        exercise_name: 'Barbell Bench',
        event_date: '2026-01-05',
        actual_weight: '225',
        actual_reps: '5',
        actual_duration: null,
        is_autofilled: false,
      },
      {
        exercise_name: 'Bench Press',
        event_date: '2026-02-10',
        actual_weight: '185',
        actual_reps: '5',
        actual_duration: null,
        is_autofilled: false,
      },
      // A different exercise entirely — must not leak into the payload.
      {
        exercise_name: 'Back Squat',
        event_date: '2026-02-11',
        actual_weight: '315',
        actual_reps: '5',
        actual_duration: null,
        is_autofilled: false,
      },
    ],
    workout_cardio_logs: [],
  };

  it('keeps pre-rename history when queried by the current name', async () => {
    const payload = (await getExerciseHistoryTool.run(makeAdmin(renamedFixtures), 'user-123', {
      exercise_name: 'Bench Press',
    })) as { canonical_name: string; all_time_best: { date: string } | null; recent_sessions: unknown[] };

    expect(payload.canonical_name).toBe('Bench Press');
    // The January row under the old spelling, not February's lighter lift.
    expect(payload.all_time_best?.date).toBe('2026-01-05');
    expect(payload.recent_sessions).toHaveLength(2);
  });

  it('resolves an alias to the canonical name and excludes other exercises', async () => {
    const payload = (await getExerciseHistoryTool.run(makeAdmin(renamedFixtures), 'user-123', {
      exercise_name: 'Barbell Bench',
    })) as { canonical_name: string; resolved_from?: string; total_sessions: number };

    expect(payload.canonical_name).toBe('Bench Press');
    expect(payload.resolved_from).toBe('Barbell Bench');
    // Two bench sessions — the squat row was filtered out by the query.
    expect(payload.total_sessions).toBe(2);
  });

  it('rejects a name with no logged history', async () => {
    await expect(
      getExerciseHistoryTool.run(makeAdmin(renamedFixtures), 'user-123', { exercise_name: 'Deadlift' }),
    ).rejects.toThrow(/No logged history/);
  });
});

describe('search_exercises — last-performed via the phase31 aggregate', () => {
  it('reports the most recent date per exercise, folding former spellings', async () => {
    const admin = makeAdmin({
      exercise_definitions: [
        { id: 'bench', canonical_name: 'Bench Press', aliases: ['Barbell Bench'], archived_at: null,
          category: 'weights', muscle_groups: [], equipment: [], is_unilateral: false,
          default_sets: null, default_reps: null, default_duration: null, default_weight: null,
          default_rest: null, technique_notes: null },
      ],
      workout_set_logs: [
        { exercise_name: 'Barbell Bench', event_date: '2026-01-05', is_autofilled: false },
        { exercise_name: 'Bench Press', event_date: '2026-02-10', is_autofilled: false },
        // Autofilled rows are plan-fills, not performances — the aggregate
        // excludes them, so this later date must not win.
        { exercise_name: 'Bench Press', event_date: '2026-03-01', is_autofilled: true },
      ],
      workout_cardio_logs: [],
    });

    const payload = (await searchExercisesTool.run(admin, 'user-123', {})) as {
      exercises: Array<{ canonical_name: string; last_performed: string | null }>;
    };

    expect(payload.exercises[0]).toMatchObject({
      canonical_name: 'Bench Press',
      last_performed: '2026-02-10',
    });
  });
});

describe('get_prs — alias-aware lineage', () => {
  it('treats logs under a former name as one lineage (renamed exercise beats its old history)', async () => {
    const admin = makeAdmin({
      exercise_definitions: [
        { id: 'back-squat', canonical_name: 'Back Squat', aliases: ['Squat'], archived_at: null },
      ],
      workout_set_logs: [
        {
          exercise_name: 'Squat',
          event_date: '2026-01-05',
          actual_weight: '100',
          actual_reps: '5',
          actual_duration: null,
          is_autofilled: false,
        },
        {
          exercise_name: 'Back Squat',
          event_date: '2026-02-10',
          actual_weight: '110',
          actual_reps: '5',
          actual_duration: null,
          is_autofilled: false,
        },
      ],
      workout_cardio_logs: [],
    });

    const payload = (await getPrsTool.run(admin, 'user-123', {
      scope: 'period',
      start_date: '2026-02-01',
      end_date: '2026-02-28',
    })) as { records: Array<{ kind: string; exerciseName: string; previousDate: string; description: string }> };

    // One lineage: the February lift is a PR because it beat January's log
    // under the OLD spelling. Split lineages would make it a no-record
    // "first-ever" instead.
    expect(payload.records).toHaveLength(1);
    expect(payload.records[0]).toMatchObject({
      kind: 'oneRM',
      exerciseName: 'Back Squat',
      previousDate: '2026-01-05',
    });
    expect(payload.records[0].description).toContain('est. 1RM');
  });

  it('all_time scope lists best-ever per exercise under the canonical name', async () => {
    const admin = makeAdmin({
      exercise_definitions: [
        { id: 'back-squat', canonical_name: 'Back Squat', aliases: ['Squat'], archived_at: null },
      ],
      workout_set_logs: [
        { exercise_name: 'Squat', event_date: '2026-01-05', actual_weight: '100', actual_reps: '5', actual_duration: null, is_autofilled: false },
        { exercise_name: 'Back Squat', event_date: '2026-02-10', actual_weight: '110', actual_reps: '5', actual_duration: null, is_autofilled: false },
      ],
      workout_cardio_logs: [],
    });

    const payload = (await getPrsTool.run(admin, 'user-123', {})) as {
      lifts: Array<{ exercise: string; estimated_1rm: number; date: string }>;
    };
    expect(payload.lifts).toEqual([
      expect.objectContaining({ exercise: 'Back Squat', date: '2026-02-10' }),
    ]);
    // Epley: 110 × (1 + 5/30) ≈ 128
    expect(payload.lifts[0].estimated_1rm).toBe(128);
  });
});

describe('get_meals — day totals', () => {
  it('sums per-day macros with stored-or-derived calories', async () => {
    const admin = makeAdmin({
      meals: [
        {
          id: 'm1', title: 'Oats', date: '2026-08-01', time: null, meal_type: 'breakfast',
          calories: null, protein_g: 20, carbs_g: 60, fiber_g: null, sugar_g: null,
          fat_total_g: 10, fat_saturated_g: null, fat_trans_g: null, notes: '',
        },
        {
          id: 'm2', title: 'Chicken bowl', date: '2026-08-01', time: null, meal_type: 'lunch',
          calories: 700, protein_g: 50, carbs_g: 70, fiber_g: null, sugar_g: null,
          fat_total_g: 20, fat_saturated_g: null, fat_trans_g: null, notes: '',
        },
      ],
    });

    const payload = (await getMealsTool.run(admin, 'user-123', {
      start_date: '2026-08-01',
      end_date: '2026-08-07',
    })) as { days: Array<{ date: string; meal_count: number; totals: { calories: number; proteinG: number }; meals?: unknown }> };

    expect(payload.days).toHaveLength(1);
    // Oats derives 20×4 + 60×4 + 10×9 = 410; bowl stores 700 → 1110.
    expect(payload.days[0]).toMatchObject({
      date: '2026-08-01',
      meal_count: 2,
      totals: expect.objectContaining({ calories: 1110, proteinG: 70 }),
    });
    expect(payload.days[0].meals).toBeUndefined(); // include_items defaults false
  });
});

// ─── W10 widenings ─────────────────────────────────────────────────────────

const blockRow = (id: string, name: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, user_id: 'user-123', name, intent: '', phase: 'base', objective_id: null,
  start_date: start, end_date_exclusive: end, weekly_targets: { cardioMinutes: 60 },
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...extra,
});

describe('get_training_blocks — ids, current week, objectives, block_id (W10)', () => {
  const fixtures = {
    training_blocks: [
      blockRow('blk-spring', 'Spring Block', '2026-03-02', '2026-03-30'),
      blockRow('blk-base', 'Base Block', '2026-08-31', '2026-09-28', { objective_id: 'obj-1' }),
    ],
    objectives: [
      { id: 'obj-1', user_id: 'user-123', name: 'Spring Objective', target_date: '2027-05-01', discipline: 'alpine',
        notes: '', required_capabilities: [], status: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
    ],
  };

  it('summaries carry ids, the objective id, and a current_week from the caller\'s today', async () => {
    const payload = (await getTrainingBlocksTool.run(makeAdmin(fixtures), 'user-123', {
      scope: 'all', include_progress: false, include_objectives: true, today: '2026-09-08',
    })) as {
      today: string;
      current: { id: string; current_week: number | null; objective: { id: string } | null } | null;
      blocks: Array<{ id: string; objective_id: string | null; current_week: number | null; weeks: number }>;
      objectives: Array<{ id: string; name: string }>;
    };
    expect(payload.today).toBe('2026-09-08');
    expect(payload.current).toMatchObject({ id: 'blk-base', current_week: 2, objective: { id: 'obj-1' } });
    expect(payload.blocks.map(b => [b.id, b.objective_id, b.current_week, b.weeks])).toEqual([
      ['blk-spring', null, null, 4],
      ['blk-base', 'obj-1', 2, 4],
    ]);
    expect(payload.objectives).toEqual([
      { id: 'obj-1', name: 'Spring Objective', discipline: 'alpine', target_date: '2027-05-01', status: 'active', notes: '' },
    ]);
  });

  it('leaves the objectives list out unless asked, and defaults today to the clock', async () => {
    const payload = (await getTrainingBlocksTool.run(makeAdmin(fixtures), 'user-123', {
      include_progress: false,
    })) as { today: string; objectives?: unknown; block?: unknown };
    expect(payload.objectives).toBeUndefined();
    expect(payload.block).toBeUndefined();
    expect(payload.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('block_id answers the named block under "block" and refuses one the caller does not have', async () => {
    const payload = (await getTrainingBlocksTool.run(makeAdmin(fixtures), 'user-123', {
      block_id: 'blk-spring', include_progress: false, today: '2026-09-08',
    })) as { block: { id: string; current_week: number | null; progress: unknown }; current: { id: string } | null };
    expect(payload.block).toMatchObject({ id: 'blk-spring', current_week: null, progress: null });
    // The current block is still named; only the progress moved.
    expect(payload.current?.id).toBe('blk-base');

    await expect(getTrainingBlocksTool.run(makeAdmin(fixtures), 'user-123', { block_id: 'blk-nope', today: '2026-09-08' }))
      .rejects.toThrow('block_id does not name one of your blocks.');
  });
});

describe('search_exercises — ids and references (W10)', () => {
  it('carries the definition id, and counts planned workouts on request (a series counts once)', async () => {
    const admin = makeAdmin({
      exercise_definitions: [
        { id: 'bench', canonical_name: 'Bench Press', aliases: [], archived_at: null,
          category: 'weights', muscle_groups: [], equipment: [], is_unilateral: false,
          default_sets: null, default_reps: null, default_duration: null, default_weight: null,
          default_rest: null, technique_notes: null },
        { id: 'row', canonical_name: 'Cable Row', aliases: [], archived_at: null,
          category: 'weights', muscle_groups: [], equipment: [], is_unilateral: false,
          default_sets: null, default_reps: null, default_duration: null, default_weight: null,
          default_rest: null, technique_notes: null },
      ],
      workout_set_logs: [],
      workout_cardio_logs: [],
      workout_events: [
        { ...baseEventRow, id: 'evt-weekly', type: 'weights', title: 'Push', date: '2026-08-05',
          is_recurring: true, recurrence_rule: 'FREQ=WEEKLY;BYDAY=WE',
          exercises: [{ id: 'e1', name: 'Bench Press', definitionId: 'bench', category: 'strength', sets: 3, reps: '5' }] },
        { ...baseEventRow, id: 'evt-once', type: 'weights', title: 'Pull', date: '2026-08-07', is_recurring: false,
          warmup: [{ id: 'w1', name: 'Bench Press', definitionId: 'bench', category: 'strength', sets: 1, reps: '10' }],
          exercises: [] },
      ],
    });

    const plain = (await searchExercisesTool.run(admin, 'user-123', {})) as {
      exercises: Array<{ id: string; references?: number }>;
    };
    expect(plain.exercises.map(e => e.id)).toEqual(['bench', 'row']);
    expect(plain.exercises[0].references).toBeUndefined();

    const counted = (await searchExercisesTool.run(admin, 'user-123', { include_references: true })) as {
      exercises: Array<{ id: string; references: number }>;
    };
    expect(counted.exercises.map(e => [e.id, e.references])).toEqual([['bench', 2], ['row', 0]]);
  });
});

describe('get_meals — items carry ids and the full fat split (W10)', () => {
  it('lists each meal with its id, saturated and trans fat, and alcohol', async () => {
    const admin = makeAdmin({
      meals: [
        {
          id: 'meal-1', title: 'Oats', date: '2026-08-01', time: '07:15', meal_type: 'breakfast',
          calories: null, protein_g: 20, carbs_g: 60, fiber_g: 5, sugar_g: 8,
          fat_total_g: 10, fat_saturated_g: 2, fat_trans_g: 0, alcohol_g: null, notes: '',
        },
      ],
    });
    const payload = (await getMealsTool.run(admin, 'user-123', {
      start_date: '2026-08-01', end_date: '2026-08-01', include_items: true,
    })) as { days: Array<{ meals: Array<Record<string, unknown>> }> };
    expect(payload.days[0].meals[0]).toEqual({
      id: 'meal-1', title: 'Oats', time: '07:15', meal_type: 'breakfast', calories: 410,
      protein_g: 20, carbs_g: 60, fiber_g: 5, sugar_g: 8,
      fat_total_g: 10, fat_saturated_g: 2, fat_trans_g: 0, alcohol_g: null, notes: null,
    });
  });
});
