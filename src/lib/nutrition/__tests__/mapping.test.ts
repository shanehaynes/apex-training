import { describe, it, expect } from 'vitest';
import {
  rowToMeal,
  mealToRow,
  mealFieldsToRow,
  favoriteToRow,
  rowToFavorite,
  derivedCalories,
  mealCalories,
  validateFatSplit,
  sumDayMacros,
} from '../mapping';
import type { MealFavoriteRow, MealRow } from '../../db/types';
import type { Meal, MealFavorite } from '../../../types/nutrition';

const FULL_MEAL: Meal = {
  id: 'meal-1',
  title: 'Chicken burrito',
  date: '2026-08-06',
  time: '12:30 PM',
  mealType: 'lunch',
  calories: 700,
  proteinG: 42,
  carbsG: 55,
  fiberG: 8,
  sugarG: 6,
  fatTotalG: 24,
  fatSaturatedG: 9,
  fatTransG: 0.5,
  alcoholG: 14,
  notes: 'Extra rice',
};

const FULL_ROW: Omit<MealRow, 'created_at' | 'updated_at'> = {
  id: 'meal-1',
  title: 'Chicken burrito',
  date: '2026-08-06',
  time: '12:30 PM',
  meal_type: 'lunch',
  calories: 700,
  protein_g: 42,
  carbs_g: 55,
  fiber_g: 8,
  sugar_g: 6,
  fat_total_g: 24,
  fat_saturated_g: 9,
  fat_trans_g: 0.5,
  alcohol_g: 14,
  notes: 'Extra rice',
};

describe('mealToRow / rowToMeal', () => {
  it('maps every field to its column and back', () => {
    expect(mealToRow(FULL_MEAL)).toEqual(FULL_ROW);
    expect(rowToMeal({ ...FULL_ROW, created_at: '', updated_at: '' })).toEqual(FULL_MEAL);
  });

  it('unset optionals become nulls in the row, and nulls come back as undefined', () => {
    const sparse: Meal = { id: 'meal-2', title: 'Snack', date: '2026-08-06', notes: '' };
    const row = mealToRow(sparse);
    expect(row.time).toBeNull();
    expect(row.meal_type).toBeNull();
    expect(row.calories).toBeNull();
    expect(row.protein_g).toBeNull();
    expect(row.fat_trans_g).toBeNull();
    expect(rowToMeal({ ...row, created_at: '', updated_at: '' })).toEqual(sparse);
  });
});

describe('favoriteToRow / rowToFavorite', () => {
  it('round-trips a favorite (a meal minus date/time)', () => {
    const { date: _d, time: _t, ...favorite } = FULL_MEAL;
    const row = favoriteToRow(favorite as MealFavorite);
    expect(row).not.toHaveProperty('date');
    expect(row).not.toHaveProperty('time');
    expect(rowToFavorite({ ...row, created_at: '', updated_at: '' } as MealFavoriteRow)).toEqual(favorite);
  });
});

describe('mealFieldsToRow', () => {
  it('emits only the columns for keys present', () => {
    expect(mealFieldsToRow({ title: 'Renamed', proteinG: 30 }))
      .toEqual({ title: 'Renamed', protein_g: 30 });
  });

  it('a key explicitly set to undefined nulls its column (clearing), an absent key stays untouched', () => {
    expect(mealFieldsToRow({ proteinG: undefined, mealType: undefined }))
      .toEqual({ protein_g: null, meal_type: null });
    expect(mealFieldsToRow({})).toEqual({});
  });
});

describe('derivedCalories', () => {
  it('applies 4/4/9 to the entered macros', () => {
    expect(derivedCalories({ proteinG: 40, carbsG: 50, fatTotalG: 25 })).toBe(585);
  });

  it('folds alcohol in at 7 kcal/g (phase 35)', () => {
    expect(derivedCalories({ proteinG: 40, carbsG: 50, fatTotalG: 25, alcoholG: 14 })).toBe(683);
    expect(derivedCalories({ alcoholG: 28 })).toBe(196);
  });

  it('treats missing macros as zero when at least one is set', () => {
    expect(derivedCalories({ proteinG: 30 })).toBe(120);
    expect(derivedCalories({ fatTotalG: 10 })).toBe(90);
  });

  it('is null when no macros are entered', () => {
    expect(derivedCalories({})).toBeNull();
  });

  it('rounds fractional grams to whole calories', () => {
    expect(derivedCalories({ fatTotalG: 0.5 })).toBe(5);
  });
});

describe('mealCalories', () => {
  it('prefers the manual override', () => {
    expect(mealCalories(FULL_MEAL)).toBe(700);
  });

  it('falls back to the derivation', () => {
    const { calories: _c, ...noOverride } = FULL_MEAL;
    expect(mealCalories(noOverride as Meal)).toBe(4 * 42 + 4 * 55 + 9 * 24 + 7 * 14);
  });

  it('is null with neither override nor macros', () => {
    expect(mealCalories({ id: 'x', title: 'x', date: '2026-08-06', notes: '' })).toBeNull();
  });
});

describe('validateFatSplit', () => {
  it('accepts total ≥ sat + trans', () => {
    expect(validateFatSplit(24, 9, 0.5)).toBe(true);
    expect(validateFatSplit(9.5, 9, 0.5)).toBe(true);
  });

  it('rejects total < sat + trans', () => {
    expect(validateFatSplit(9, 9, 0.5)).toBe(false);
    expect(validateFatSplit(5, 9)).toBe(false);
  });

  it('accepts an unset total regardless of the split', () => {
    expect(validateFatSplit(undefined, 9, 0.5)).toBe(true);
  });

  it('accepts a total with a partial or missing split', () => {
    expect(validateFatSplit(24)).toBe(true);
    expect(validateFatSplit(24, undefined, 3)).toBe(true);
  });
});

describe('sumDayMacros', () => {
  it('sums macros and stored-or-derived calories across meals', () => {
    const derivedOnly: Meal = {
      id: 'meal-3', title: 'Shake', date: '2026-08-06', notes: '',
      proteinG: 30, carbsG: 10,
    };
    const totals = sumDayMacros([FULL_MEAL, derivedOnly]);
    expect(totals).toEqual({
      calories: 700 + 160,
      proteinG: 72,
      carbsG: 65,
      fatTotalG: 24,
    });
  });

  it('is all zeros for an empty day', () => {
    expect(sumDayMacros([])).toEqual({ calories: 0, proteinG: 0, carbsG: 0, fatTotalG: 0 });
  });

  it('rounds float-sum noise for display', () => {
    const meal = (id: string, proteinG: number): Meal =>
      ({ id, title: id, date: '2026-08-06', notes: '', proteinG });
    const totals = sumDayMacros([meal('a', 0.1), meal('b', 0.2)]);
    expect(totals.proteinG).toBe(0.3);
  });
});
