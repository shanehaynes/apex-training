import { describe, it, expect } from 'vitest';
import type { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { getScheduleTool } from '../_lib/mcp/tools/schedule';
import { getPrsTool } from '../_lib/mcp/tools/tracking';
import { getMealsTool } from '../_lib/mcp/tools/meals';

// Tool-level tests over fixture rows: the plumbing between the service-role
// queries and the pure src/lib computations. No handler/HTTP involved.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

function makeAdmin(fixtures: Record<string, unknown[]>): Admin {
  return {
    from(table: string) {
      const rows = fixtures[table] ?? [];
      let from = 0;
      let to = rows.length - 1;
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const m of ['select', 'order', 'eq', 'gte', 'lte', 'lt', 'is', 'or']) builder[m] = chain;
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
