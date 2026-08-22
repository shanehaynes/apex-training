import { createContext, useContext } from 'react';
import type { CreateMealInput, Meal, MealFavorite, SaveMealFavoriteInput, UpdateMealInput } from '../types/nutrition';

// Context object + hook live apart from the provider so MealsContext.tsx
// exports only a component and stays eligible for React Fast Refresh.

export interface MealsContextValue {
  meals: Meal[];
  getMealsForDate: (date: Date) => Meal[];
  createMeal: (input: CreateMealInput) => Promise<{ id: string } | null>;
  updateMeal: (input: UpdateMealInput) => Promise<boolean>;
  deleteMeal: (id: string, triggeredBy?: 'user' | 'ai') => Promise<boolean>;
  /** Meal templates, alphabetical. Empty offline. */
  favorites: MealFavorite[];
  /** Upserts: pass an existing favorite's id to overwrite it (same-title saves). */
  saveFavorite: (input: SaveMealFavoriteInput) => Promise<{ id: string } | null>;
  deleteFavorite: (id: string) => Promise<boolean>;
}

export const MealsContext = createContext<MealsContextValue | null>(null);

export function useMeals() {
  const ctx = useContext(MealsContext);
  if (!ctx) throw new Error('useMeals must be used within MealsProvider');
  return ctx;
}
