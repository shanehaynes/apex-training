// Nutrition domain model (meals logged against calendar days). Meals are
// deliberately separate from WorkoutEvent: no completion, recurrence, or
// ICS-feed semantics apply to them.

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

export interface Meal {
  id: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** Display convention ("5:30 PM"), same as WorkoutEvent.startTime. */
  time?: string;
  mealType?: MealType;
  /** Manual override; when absent, display derives 4/4/9 from the macros. */
  calories?: number;
  proteinG?: number;
  carbsG?: number;
  fiberG?: number;
  sugarG?: number;
  /** Independent of the split: sat + trans never sum to total (unsaturated fats exist). */
  fatTotalG?: number;
  fatSaturatedG?: number;
  fatTransG?: number;
  /** Grams of ethanol (a 14 g "standard drink" is display-side); contributes 7 kcal/g to derived calories. */
  alcoholG?: number;
  notes: string;
}

export type CreateMealInput = Omit<Meal, 'id'> & {
  /** Audit-log attribution; MealsContext defaults to 'user', the coach executor passes 'ai'. */
  triggeredBy?: 'user' | 'ai';
};

/** A reusable meal template: a Meal minus its calendar placement. */
export type MealFavorite = Omit<Meal, 'date' | 'time'>;

export type SaveMealFavoriteInput = Omit<MealFavorite, 'id'> & {
  /** Reuse an existing favorite's id to overwrite it (same-title saves). */
  id?: string;
};

export interface UpdateMealInput {
  id: string;
  fields: Partial<Omit<Meal, 'id'>>;
  /** Audit-log attribution; MealsContext defaults to 'user', the coach executor passes 'ai'. */
  triggeredBy?: 'user' | 'ai';
}
