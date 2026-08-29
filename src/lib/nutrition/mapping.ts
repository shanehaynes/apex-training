import type { MealFavoriteRow, MealRow } from '../db/types';
import type { Meal, MealFavorite, MealType } from '../../types/nutrition';

// ─── Row ↔ Meal mapping ──────────────────────────────────────────────────────
// Pure converters between the app's camelCase Meal and the DB's snake_case
// meals columns, plus the derived-nutrition helpers shared by the composer
// and the day-modal display.

type MealRowInsert = Omit<MealRow, 'created_at' | 'updated_at'>;

export function rowToMeal(row: MealRow): Meal {
  return {
    id:            row.id,
    title:         row.title,
    date:          row.date,
    time:          row.time ?? undefined,
    mealType:      (row.meal_type ?? undefined) as MealType | undefined,
    calories:      row.calories ?? undefined,
    proteinG:      row.protein_g ?? undefined,
    carbsG:        row.carbs_g ?? undefined,
    fiberG:        row.fiber_g ?? undefined,
    sugarG:        row.sugar_g ?? undefined,
    fatTotalG:     row.fat_total_g ?? undefined,
    fatSaturatedG: row.fat_saturated_g ?? undefined,
    fatTransG:     row.fat_trans_g ?? undefined,
    alcoholG:      row.alcohol_g ?? undefined,
    notes:         row.notes ?? '',
  };
}

// One converter per Meal field that maps onto meals columns — the camelCase ↔
// snake_case knowledge exists exactly once (id is handled in mealToRow), same
// shape as EVENT_FIELDS in src/lib/schedule/mapping.ts.
const MEAL_FIELDS: {
  [K in keyof Meal]?: (value: Meal[K] | undefined) => Partial<MealRowInsert>;
} = {
  title:         v => ({ title: v as string }),
  date:          v => ({ date: v as string }),
  time:          v => ({ time: v ?? null }),
  mealType:      v => ({ meal_type: v ?? null }),
  calories:      v => ({ calories: v ?? null }),
  proteinG:      v => ({ protein_g: v ?? null }),
  carbsG:        v => ({ carbs_g: v ?? null }),
  fiberG:        v => ({ fiber_g: v ?? null }),
  sugarG:        v => ({ sugar_g: v ?? null }),
  fatTotalG:     v => ({ fat_total_g: v ?? null }),
  fatSaturatedG: v => ({ fat_saturated_g: v ?? null }),
  fatTransG:     v => ({ fat_trans_g: v ?? null }),
  alcoholG:      v => ({ alcohol_g: v ?? null }),
  notes:         v => ({ notes: v ?? '' }),
};

const MEAL_FIELD_ENTRIES = Object.entries(MEAL_FIELDS) as [
  keyof Meal,
  (value: unknown) => Partial<MealRowInsert>,
][];

export function mealToRow(m: Meal): MealRowInsert {
  const row = { id: m.id } as MealRowInsert;
  for (const [key, convert] of MEAL_FIELD_ENTRIES) {
    Object.assign(row, convert(m[key]));
  }
  return row;
}

// ─── Row ↔ MealFavorite mapping ──────────────────────────────────────────────
// A favorite is a meal template: the same fields minus date/time, so the
// converters reuse MEAL_FIELDS filtered down to the shared keys.

type FavoriteRowInsert = Omit<MealFavoriteRow, 'created_at' | 'updated_at'>;

const FAVORITE_FIELD_ENTRIES = MEAL_FIELD_ENTRIES.filter(([key]) => key !== 'date' && key !== 'time');

export function favoriteToRow(f: MealFavorite): FavoriteRowInsert {
  const row = { id: f.id } as FavoriteRowInsert;
  for (const [key, convert] of FAVORITE_FIELD_ENTRIES) {
    Object.assign(row, convert(f[key as keyof MealFavorite]));
  }
  return row;
}

export function rowToFavorite(row: MealFavoriteRow): MealFavorite {
  return {
    id:            row.id,
    title:         row.title,
    mealType:      (row.meal_type ?? undefined) as MealType | undefined,
    calories:      row.calories ?? undefined,
    proteinG:      row.protein_g ?? undefined,
    carbsG:        row.carbs_g ?? undefined,
    fiberG:        row.fiber_g ?? undefined,
    sugarG:        row.sugar_g ?? undefined,
    fatTotalG:     row.fat_total_g ?? undefined,
    fatSaturatedG: row.fat_saturated_g ?? undefined,
    fatTransG:     row.fat_trans_g ?? undefined,
    alcoholG:      row.alcohol_g ?? undefined,
    notes:         row.notes ?? '',
  };
}

/**
 * Only the columns for KEYS present in fields — for PATCH bodies. Presence,
 * not definedness: a key explicitly set to undefined nulls its column
 * (clearing a field from the full-form editor), while an absent key leaves
 * the column untouched (the coach's partial updates).
 */
export function mealFieldsToRow(
  fields: Partial<Omit<Meal, 'id'>>,
): Partial<MealRowInsert> {
  const row: Partial<MealRowInsert> = {};
  for (const [key, convert] of MEAL_FIELD_ENTRIES) {
    if (!(key in fields)) continue;
    Object.assign(row, convert(fields[key as keyof typeof fields]));
  }
  return row;
}

// ─── Derived nutrition ───────────────────────────────────────────────────────

type Macros = Pick<Meal, 'proteinG' | 'carbsG' | 'fatTotalG' | 'alcoholG'>;

/** Atwater 4/4/9/7 estimate from the entered macros; null when none are set. */
export function derivedCalories(m: Macros): number | null {
  if (m.proteinG === undefined && m.carbsG === undefined && m.fatTotalG === undefined && m.alcoholG === undefined) return null;
  return Math.round((m.proteinG ?? 0) * 4 + (m.carbsG ?? 0) * 4 + (m.fatTotalG ?? 0) * 9 + (m.alcoholG ?? 0) * 7);
}

/** The calories a meal displays as: the manual override when set, else derived. */
export function mealCalories(m: Meal): number | null {
  return m.calories ?? derivedCalories(m);
}

/**
 * A fat split is invalid only when the total is set below sat + trans.
 * Never auto-sum the split into the total — mono/poly-unsaturated fats mean
 * total is legitimately larger, and a blank total stays unset.
 */
export function validateFatSplit(total?: number, saturated?: number, trans?: number): boolean {
  if (total === undefined) return true;
  return total >= (saturated ?? 0) + (trans ?? 0);
}

export interface DayMacros {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatTotalG: number;
}

/** Display-rounded: whole calories, tenth-gram macros (0.1 + 0.2 must not render as 0.30000000000000004). */
const tenth = (n: number) => Math.round(n * 10) / 10;

/** Sums for the day-modal totals strip, using stored-or-derived calories per meal. */
export function sumDayMacros(meals: Meal[]): DayMacros {
  const totals: DayMacros = { calories: 0, proteinG: 0, carbsG: 0, fatTotalG: 0 };
  for (const m of meals) {
    totals.calories  += mealCalories(m) ?? 0;
    totals.proteinG  += m.proteinG ?? 0;
    totals.carbsG    += m.carbsG ?? 0;
    totals.fatTotalG += m.fatTotalG ?? 0;
  }
  totals.calories  = Math.round(totals.calories);
  totals.proteinG  = tenth(totals.proteinG);
  totals.carbsG    = tenth(totals.carbsG);
  totals.fatTotalG = tenth(totals.fatTotalG);
  return totals;
}
