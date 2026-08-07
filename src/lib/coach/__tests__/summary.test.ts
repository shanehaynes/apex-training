import { describe, it, expect } from 'vitest';
import { buildNutritionSection, buildSessionRecap } from '../summary';
import type { Meal } from '../../../types/nutrition';
import type { WorkoutEvent } from '../../../types/workout';

const EVENT = {
  id: 'evt-1',
  type: 'weights',
  title: 'Upper Body',
  date: '2026-08-06',
  estimatedDuration: 60,
  difficulty: 3,
  description: '',
  warmup: [],
  exercises: [],
  cooldown: [],
  tags: [],
  equipment: [],
  isCompleted: false,
  isRecurring: false,
} as unknown as WorkoutEvent;

const BURRITO: Meal = {
  id: 'meal-1',
  title: 'Chicken burrito',
  date: '2026-08-06',
  time: '12:30 PM',
  mealType: 'lunch',
  proteinG: 40,
  carbsG: 50,
  fatTotalG: 25,
  notes: '',
};

const SHAKE: Meal = {
  id: 'meal-2',
  title: 'Protein shake',
  date: '2026-08-06',
  calories: 200,
  proteinG: 30,
  notes: '',
};

describe('buildNutritionSection', () => {
  it('is empty with no meals — the model gets nothing to nag about', () => {
    expect(buildNutritionSection([])).toBe('');
  });

  it('lists each meal with derived-or-stored calories and day totals', () => {
    const section = buildNutritionSection([BURRITO, SHAKE]);
    expect(section).toContain('- Chicken burrito (lunch, 12:30 PM): 585 kcal · P 40 · C 50 · F 25');
    expect(section).toContain('- Protein shake: 200 kcal · P 30');
    expect(section).toContain('Day totals: 785 kcal · protein 70g · carbs 50g · fat 25g');
  });

  it('a meal without macros reads as unlogged, not zero', () => {
    const bare: Meal = { id: 'm', title: 'Snack', date: '2026-08-06', notes: '' };
    expect(buildNutritionSection([bare])).toContain('- Snack: no macros logged');
  });
});

describe('buildSessionRecap nutrition integration', () => {
  it('appends the nutrition section after the PR block when meals exist', () => {
    const recap = buildSessionRecap(EVENT, [], null, [], [BURRITO]);
    expect(recap.indexOf('No personal records')).toBeLessThan(recap.indexOf('NUTRITION logged'));
    expect(recap).toContain('Day totals: 585 kcal');
  });

  it('omits the section entirely (and by default) when no meals are passed', () => {
    expect(buildSessionRecap(EVENT, [], null, [])).not.toContain('NUTRITION');
    expect(buildSessionRecap(EVENT, [], null, [], [])).not.toContain('NUTRITION');
  });
});
