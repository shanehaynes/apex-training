import { useEffect, useMemo, useReducer } from 'react';
import { addMonths, subMonths, addWeeks, subWeeks, addDays, subDays } from 'date-fns';
import { registerAgentState } from '../dev/agentBridge';
import { now } from '../lib/clock';
import { CalendarContext, type CalendarAction, type CalendarState } from './calendar';

function reducer(state: CalendarState, action: CalendarAction): CalendarState {
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
    default:
      return state;
  }
}

export function CalendarProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    currentDate: now(),
    selectedView: 'month',
    selectedEvent: null,
    trackingSession: null,
    libraryOpen: false,
    librarySelection: null,
    selectedDay: null,
    composerDate: null,
    editingWorkout: null,
    mealComposerDate: null,
    editingMeal: null,
    profileOpen: false,
    blocksOpen: false,
  });

  // Dev-only agent bridge: compiled out of production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    return registerAgentState('calendar', () => ({
      currentDate: state.currentDate.toISOString(),
      selectedView: state.selectedView,
      selectedEventId: state.selectedEvent?.id ?? null,
      trackingEventId: state.trackingSession?.id ?? null,
      libraryOpen: state.libraryOpen,
      librarySelection: state.librarySelection,
      selectedDay: state.selectedDay,
      composerDate: state.composerDate,
      editingWorkoutId: state.editingWorkout?.id ?? null,
      mealComposerDate: state.mealComposerDate,
      editingMealId: state.editingMeal?.id ?? null,
      profileOpen: state.profileOpen,
      blocksOpen: state.blocksOpen,
    }));
  }, [state]);

  // dispatch is stable, so the value identity tracks state alone.
  const value = useMemo(() => ({ state, dispatch }), [state]);

  return <CalendarContext.Provider value={value}>{children}</CalendarContext.Provider>;
}
