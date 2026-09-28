import { createContext, useContext, type Dispatch } from 'react';
import { addMonths, subMonths, addWeeks, subWeeks, addDays, subDays } from 'date-fns';
import { now } from '../lib/clock';
import type { CalendarView, WorkoutEvent } from '../types/workout';
import type { Meal } from '../types/nutrition';
import type { AskCoachRequest } from '../lib/coach/askContext';

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
  /** Weekly review overlay (same full-screen pattern as the library). */
  weeklyReviewOpen: boolean;
  /** Analytics dashboard overlay (same full-screen pattern as the library). */
  analyticsOpen: boolean;
  /** Coach notebook overlay (memory, contract, doctrine — lane D02); opens from the profile. */
  notebookOpen: boolean;
  /**
   * A session the athlete asked the coach about (lane E02): set by the
   * workout modal or the tracker's summary, sent by ChatSidebar as a hidden
   * user turn once the pane is free, then cleared. Null between asks.
   */
  askCoach: AskCoachRequest | null;
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
  | { type: 'OPEN_WEEKLY_REVIEW' }
  | { type: 'CLOSE_WEEKLY_REVIEW' }
  | { type: 'OPEN_ANALYTICS' }
  | { type: 'CLOSE_ANALYTICS' }
  | { type: 'OPEN_NOTEBOOK' }
  | { type: 'CLOSE_NOTEBOOK' }
  | { type: 'ASK_COACH'; payload: AskCoachRequest }
  | { type: 'CLEAR_ASK_COACH' };

/** The calendar's state machine. Here rather than in the provider file so it
 *  is importable by tests without a DOM, and CalendarContext.tsx keeps
 *  exporting only a component. */
export function calendarReducer(state: CalendarState, action: CalendarAction): CalendarState {
  switch (action.type) {
    case 'NEXT_PERIOD':
      return {
        ...state,
        currentDate: state.selectedView === 'month'
          ? addMonths(state.currentDate, 1)
          : state.selectedView === 'week'
          ? addWeeks(state.currentDate, 1)
          : addDays(state.currentDate, 1),
      };
    case 'PREV_PERIOD':
      return {
        ...state,
        currentDate: state.selectedView === 'month'
          ? subMonths(state.currentDate, 1)
          : state.selectedView === 'week'
          ? subWeeks(state.currentDate, 1)
          : subDays(state.currentDate, 1),
      };
    case 'GO_TO_TODAY':
      return { ...state, currentDate: now() };
    case 'GO_TO_DATE':
      return { ...state, currentDate: action.payload };
    case 'SET_VIEW':
      return { ...state, selectedView: action.payload };
    case 'SELECT_EVENT':
      // Also closes the day modal — the workout modal replaces it rather than
      // stacking a second backdrop.
      return { ...state, selectedEvent: action.payload, selectedDay: null };
    case 'CLEAR_EVENT':
      return { ...state, selectedEvent: null };
    case 'START_TRACKING':
      return { ...state, trackingSession: action.payload, selectedEvent: null };
    case 'STOP_TRACKING':
      return { ...state, trackingSession: null };
    case 'OPEN_LIBRARY':
      return { ...state, libraryOpen: true, librarySelection: action.payload ?? null };
    case 'CLOSE_LIBRARY':
      return { ...state, libraryOpen: false, librarySelection: null };
    case 'SELECT_DAY':
      return { ...state, selectedDay: action.payload };
    case 'CLEAR_DAY':
      return { ...state, selectedDay: null };
    case 'OPEN_COMPOSER':
      return { ...state, composerDate: action.payload, editingWorkout: null, selectedDay: null };
    case 'OPEN_EVENT_EDITOR':
      // Replaces the workout modal rather than stacking over it.
      return { ...state, composerDate: action.payload.date, editingWorkout: action.payload, selectedEvent: null, selectedDay: null };
    case 'CLOSE_COMPOSER':
      return { ...state, composerDate: null, editingWorkout: null };
    case 'OPEN_MEAL_COMPOSER':
      return { ...state, mealComposerDate: action.payload, editingMeal: null, selectedDay: null };
    case 'OPEN_MEAL_EDITOR':
      return { ...state, mealComposerDate: action.payload.date, editingMeal: action.payload, selectedDay: null };
    case 'CLOSE_MEAL_COMPOSER':
      return { ...state, mealComposerDate: null, editingMeal: null };
    case 'OPEN_PROFILE':
      return { ...state, profileOpen: true };
    case 'CLOSE_PROFILE':
      return { ...state, profileOpen: false };
    case 'OPEN_BLOCKS':
      return { ...state, blocksOpen: true };
    case 'CLOSE_BLOCKS':
      return { ...state, blocksOpen: false };
    case 'OPEN_WEEKLY_REVIEW':
      return { ...state, weeklyReviewOpen: true };
    case 'CLOSE_WEEKLY_REVIEW':
      return { ...state, weeklyReviewOpen: false };
    case 'OPEN_ANALYTICS':
      return { ...state, analyticsOpen: true };
    case 'CLOSE_ANALYTICS':
      return { ...state, analyticsOpen: false };
    case 'OPEN_NOTEBOOK':
      return { ...state, notebookOpen: true };
    case 'CLOSE_NOTEBOOK':
      return { ...state, notebookOpen: false };
    case 'ASK_COACH':
      // Also closes the workout modal: on a phone the coach tab replaces the
      // calendar, and a modal left open would sit over the answer.
      return { ...state, askCoach: action.payload, selectedEvent: null };
    case 'CLEAR_ASK_COACH':
      return { ...state, askCoach: null };
    default:
      return state;
  }
}

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
