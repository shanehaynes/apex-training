import type { McpToolDef } from '../protocol.js';
import { optionalBoolean, requireDateRange } from '../args.js';
import { fetchAllPages } from '../../pagination.js';
import type { MealRow } from '../../../../src/lib/db/types.js';
import { mealCalories, rowToMeal, sumDayMacros } from '../../../../src/lib/nutrition/mapping.js';

// Nutrition tool: meals in a range with per-day macro totals (calories are
// stored-or-derived via the same 4/4/9 Atwater rule the app displays).

const MAX_MEAL_DAYS = 31;

export const getMealsTool: McpToolDef = {
  name: 'get_meals',
  description:
    'Meals logged in a date range (max 31 days) with per-day macro totals (calories, protein, carbs, fat). ' +
    'Set include_items true for the individual meals behind each day.',
  inputSchema: {
    type: 'object',
    properties: {
      start_date: { type: 'string', description: 'Range start, YYYY-MM-DD (inclusive).' },
      end_date: { type: 'string', description: 'Range end, YYYY-MM-DD (inclusive).' },
      include_items: { type: 'boolean', description: 'Include individual meals per day (default false).' },
    },
    required: ['start_date', 'end_date'],
  },
  async run(supabase, userId, args) {
    const { startDate, endDate } = requireDateRange(args, MAX_MEAL_DAYS);
    const includeItems = optionalBoolean(args, 'include_items', false);

    const rows = await fetchAllPages<MealRow>('meals', (from, to) =>
      supabase
        .from('meals')
        .select('*')
        .eq('user_id', userId)
        .gte('date', startDate)
        .lte('date', endDate)
        .order('date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    );

    const byDate = new Map<string, ReturnType<typeof rowToMeal>[]>();
    for (const row of rows) {
      const meal = rowToMeal(row);
      byDate.set(meal.date, [...(byDate.get(meal.date) ?? []), meal]);
    }

    const days = [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, meals]) => ({
        date,
        meal_count: meals.length,
        totals: sumDayMacros(meals),
        meals: includeItems
          ? meals.map(m => ({
              title: m.title,
              time: m.time ?? null,
              meal_type: m.mealType ?? null,
              calories: mealCalories(m),
              protein_g: m.proteinG ?? null,
              carbs_g: m.carbsG ?? null,
              fiber_g: m.fiberG ?? null,
              sugar_g: m.sugarG ?? null,
              fat_total_g: m.fatTotalG ?? null,
              notes: m.notes || null,
            }))
          : undefined,
      }));

    return { start_date: startDate, end_date: endDate, days };
  },
};
