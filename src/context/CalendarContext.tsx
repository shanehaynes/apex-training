import { createContext, useContext, useReducer } from 'react';
import { addMonths, subMonths, addWeeks, subWeeks, addDays, subDays } from 'date-fns';
import type { CalendarView, WorkoutEvent } from '../types/workout';

interface CalendarState {
  currentDate: Date;
  selectedView: CalendarView;
  selectedEvent: WorkoutEvent | null;
  // Deliberately not a selectedView arm: AppShell force-resets selectedView
  // by viewport width, which would kick a tracker "view" back to the
  // calendar mid-workout on mobile. The event snapshot is the occurrence
  // (expanded `base__date` id for recurring events), so id + date pin the
  // exact instance being tracked.
  trackingSession: WorkoutEvent | null;
}

type CalendarAction =
  | { type: 'NEXT_PERIOD' }
  | { type: 'PREV_PERIOD' }
  | { type: 'GO_TO_TODAY' }
  | { type: 'GO_TO_DATE'; payload: Date }
  | { type: 'SET_VIEW'; payload: CalendarView }
  | { type: 'SELECT_EVENT'; payload: WorkoutEvent }
  | { type: 'CLEAR_EVENT' }
  | { type: 'START_TRACKING'; payload: WorkoutEvent }
  | { type: 'STOP_TRACKING' };

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
      return { ...state, currentDate: new Date() };
    case 'GO_TO_DATE':
      return { ...state, currentDate: action.payload };
    case 'SET_VIEW':
      return { ...state, selectedView: action.payload };
    case 'SELECT_EVENT':
      return { ...state, selectedEvent: action.payload };
    case 'CLEAR_EVENT':
      return { ...state, selectedEvent: null };
    case 'START_TRACKING':
      return { ...state, trackingSession: action.payload, selectedEvent: null };
    case 'STOP_TRACKING':
      return { ...state, trackingSession: null };
    default:
      return state;
  }
}

interface CalendarContextValue {
  state: CalendarState;
  dispatch: React.Dispatch<CalendarAction>;
}

const CalendarContext = createContext<CalendarContextValue | null>(null);

export function CalendarProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    currentDate: new Date(),
    selectedView: 'month',
    selectedEvent: null,
    trackingSession: null,
  });
  return <CalendarContext.Provider value={{ state, dispatch }}>{children}</CalendarContext.Provider>;
}

export function useCalendar() {
  const ctx = useContext(CalendarContext);
  if (!ctx) throw new Error('useCalendar must be used within CalendarProvider');
  return ctx;
}
