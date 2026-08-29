import { createContext, useContext, type Dispatch } from 'react';
import type { CalendarView, WorkoutEvent } from '../types/workout';
import type { Meal } from '../types/nutrition';

// Context object + hook live apart from the provider so CalendarContext.tsx
// exports only a component and stays eligible for React Fast Refresh.

export interface CalendarState {
  currentDate: Date;
  selectedView: CalendarView;
  selectedEvent: WorkoutEvent | null;
  // Deliberately not a selectedView arm: AppShell force-resets selectedView
  // by viewport width, which would kick a tracker "view" back to the
  // calendar mid-workout on mobile. The event snapshot is the occurrence
  // (expanded `base__date` id for recurring events), so id + date pin the
  // exact instance being tracked.
  trackingSession: WorkoutEvent | null;
  /** Exercise library overlay (same full-screen pattern as the tracker). */
  libraryOpen: boolean;
  /** Definition id to open the library on (deep link from an exercise name). */
  librarySelection: string | null;
  /** Day whose events are shown in the day modal (YYYY-MM-DD). */
  selectedDay: string | null;
  /** Prefilled date for the workout-builder overlay (YYYY-MM-DD). */
  composerDate: string | null;
  /** Event being edited in the builder (null = composing a new workout). */
  editingWorkout: WorkoutEvent | null;
  /** Prefilled date for the add-meal composer overlay (YYYY-MM-DD). */
  mealComposerDate: string | null;
  /** Meal being edited in the composer (null = composing a new meal). */
  editingMeal: Meal | null;
  /** Profile overlay (same full-screen pattern as the library). */
  profileOpen: boolean;
  /** Training-blocks overlay (same full-screen pattern as the library). */
  blocksOpen: boolean;
  /** Analytics dashboard overlay (same full-screen pattern as the library). */
  analyticsOpen: boolean;
}

export type CalendarAction =
  | { type: 'NEXT_PERIOD' }
  | { type: 'PREV_PERIOD' }
  | { type: 'GO_TO_TODAY' }
  | { type: 'GO_TO_DATE'; payload: Date }
  | { type: 'SET_VIEW'; payload: CalendarView }
  | { type: 'SELECT_EVENT'; payload: WorkoutEvent }
  | { type: 'CLEAR_EVENT' }
  | { type: 'START_TRACKING'; payload: WorkoutEvent }
  | { type: 'STOP_TRACKING' }
  | { type: 'OPEN_LIBRARY'; payload?: string }
  | { type: 'CLOSE_LIBRARY' }
  | { type: 'SELECT_DAY'; payload: string }
  | { type: 'CLEAR_DAY' }
  | { type: 'OPEN_COMPOSER'; payload: string }
  | { type: 'OPEN_EVENT_EDITOR'; payload: WorkoutEvent }
  | { type: 'CLOSE_COMPOSER' }
  | { type: 'OPEN_MEAL_COMPOSER'; payload: string }
  | { type: 'OPEN_MEAL_EDITOR'; payload: Meal }
  | { type: 'CLOSE_MEAL_COMPOSER' }
  | { type: 'OPEN_PROFILE' }
  | { type: 'CLOSE_PROFILE' }
  | { type: 'OPEN_BLOCKS' }
  | { type: 'CLOSE_BLOCKS' }
  | { type: 'OPEN_ANALYTICS' }
  | { type: 'CLOSE_ANALYTICS' };

export interface CalendarContextValue {
  state: CalendarState;
  dispatch: Dispatch<CalendarAction>;
}

export const CalendarContext = createContext<CalendarContextValue | null>(null);

export function useCalendar() {
  const ctx = useContext(CalendarContext);
  if (!ctx) throw new Error('useCalendar must be used within CalendarProvider');
  return ctx;
}
