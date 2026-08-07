import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { deleteJson, patchJson, postJson } from '../lib/api';
import { supabase } from '../lib/supabaseClient';
import type { MealFavoriteRow, MealRow } from '../lib/db/types';
import type { CreateMealInput, Meal, MealFavorite, SaveMealFavoriteInput, UpdateMealInput } from '../types/nutrition';
import { favoriteToRow, mealFieldsToRow, mealToRow, rowToFavorite, rowToMeal } from '../lib/nutrition/mapping';
import { timeToMinutes } from '../lib/time';
import { registerAgentState } from '../dev/agentBridge';

// Slim data layer for meals (phase 22) — deliberately separate from the
// 400-line ScheduleContext: meals share none of its recurrence, completion,
// or library machinery. Offline (no Supabase) there is no seed data — the
// meal list is empty and createMeal returns null, surfacing the same
// failure toast as event creation.

interface MealsContextValue {
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

const MealsContext = createContext<MealsContextValue | null>(null);

export function MealsProvider({ children }: { children: React.ReactNode }) {
  const [meals, setMeals] = useState<Meal[]>([]);
  const [favorites, setFavorites] = useState<MealFavorite[]>([]);

  const loadMeals = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase.from('meals').select('*').order('date');
    if (error) {
      // Tolerated (e.g. the phase22 migration hasn't run) — the day modal
      // just shows no meals.
      console.warn('[apex] Failed to load meals:', error.message);
      return;
    }
    setMeals((data as MealRow[]).map(rowToMeal));
  }, []);

  const loadFavorites = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase.from('meal_favorites').select('*').order('title');
    if (error) {
      // Tolerated (e.g. the phase24 migration hasn't run) — the composer
      // just shows no library row.
      console.warn('[apex] Failed to load meal favorites:', error.message);
      return;
    }
    setFavorites((data as MealFavoriteRow[]).map(rowToFavorite));
  }, []);

  useEffect(() => { loadMeals(); loadFavorites(); }, [loadMeals, loadFavorites]);

  // Realtime: re-fetch on any change so other devices converge; local writes
  // are applied optimistically and reconciled by the same refetch.
  useEffect(() => {
    const sb = supabase;
    if (!sb) return;
    const channel = sb
      .channel('meal-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'meals' }, loadMeals)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'meal_favorites' }, loadFavorites)
      .subscribe();
    return () => { sb.removeChannel(channel); };
  }, [loadMeals, loadFavorites]);

  const getMealsForDate = useMemo(
    () => (date: Date) => {
      const day = format(date, 'yyyy-MM-dd');
      return meals
        .filter(m => m.date === day)
        .sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
    },
    [meals],
  );

  const createMeal = useCallback(async (input: CreateMealInput): Promise<{ id: string } | null> => {
    if (!supabase) return null;

    // triggeredBy is request metadata, not a meal field — keep it out of the
    // optimistic state and the row payload.
    const { triggeredBy, ...fields } = input;
    // UUID, not a timestamp: meals.id is a global PK across users, so two
    // people logging at the same millisecond must never collide.
    const meal: Meal = { ...fields, id: `meal-${crypto.randomUUID()}` };
    try {
      await postJson('/api/meals', { ...mealToRow(meal), triggered_by: triggeredBy ?? 'user' }, 'Saving meal');
      setMeals(prev => [...prev, meal]);
      return { id: meal.id };
    } catch {
      return null;
    }
  }, []);

  const updateMeal = useCallback(async ({ id, fields, triggeredBy }: UpdateMealInput): Promise<boolean> => {
    if (!supabase) return false;

    const current = meals.find(m => m.id === id);
    try {
      await patchJson(`/api/meals?id=${encodeURIComponent(id)}`, {
        fields: mealFieldsToRow(fields),
        log: {
          meal_title: fields.title ?? current?.title ?? id,
          diff: { before: current ?? {}, after: fields },
          triggered_by: triggeredBy ?? 'user',
        },
      }, 'Updating meal');
      // Apply locally on success — the realtime refetch reconciles later, but
      // the UI (the reopened day modal) must not wait for it.
      setMeals(prev => prev.map(m => m.id !== id ? m : { ...m, ...fields }));
      return true;
    } catch {
      return false;
    }
  }, [meals]);

  const deleteMeal = useCallback(async (id: string, triggeredBy: 'user' | 'ai' = 'user'): Promise<boolean> => {
    if (!supabase) return false;

    const meal = meals.find(m => m.id === id);
    try {
      await deleteJson(`/api/meals?id=${encodeURIComponent(id)}`, 'Deleting meal', {
        log: { meal_title: meal?.title ?? id, triggered_by: triggeredBy },
      });
      setMeals(prev => prev.filter(m => m.id !== id));
      return true;
    } catch {
      return false;
    }
  }, [meals]);

  const saveFavorite = useCallback(async (input: SaveMealFavoriteInput): Promise<{ id: string } | null> => {
    if (!supabase) return null;

    const favorite: MealFavorite = { ...input, id: input.id ?? `mealfav-${crypto.randomUUID()}` };
    try {
      await postJson('/api/meal-favorites', favoriteToRow(favorite), 'Saving to library');
      // Optimistic replace-or-append, keeping the alphabetical order.
      setFavorites(prev =>
        [...prev.filter(f => f.id !== favorite.id), favorite].sort((a, b) => a.title.localeCompare(b.title)),
      );
      return { id: favorite.id };
    } catch {
      return null;
    }
  }, []);

  const deleteFavorite = useCallback(async (id: string): Promise<boolean> => {
    if (!supabase) return false;
    try {
      await deleteJson(`/api/meal-favorites?id=${encodeURIComponent(id)}`, 'Removing from library');
      setFavorites(prev => prev.filter(f => f.id !== id));
      return true;
    } catch {
      return false;
    }
  }, []);

  // Dev-only agent bridge: compiled out of production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    return registerAgentState('meals', () => ({
      mealCount: meals.length,
      canSave: !!supabase,
      favorites: favorites.map(f => ({ id: f.id, title: f.title })),
      meals: meals.map(m => ({
        id: m.id,
        title: m.title,
        date: m.date,
        time: m.time,
        mealType: m.mealType,
        calories: m.calories,
      })),
    }));
  }, [meals, favorites]);

  return (
    <MealsContext.Provider value={{ meals, getMealsForDate, createMeal, updateMeal, deleteMeal, favorites, saveFavorite, deleteFavorite }}>
      {children}
    </MealsContext.Provider>
  );
}

export function useMeals() {
  const ctx = useContext(MealsContext);
  if (!ctx) throw new Error('useMeals must be used within MealsProvider');
  return ctx;
}
