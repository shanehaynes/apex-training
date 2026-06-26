import { createContext, useContext, useReducer } from 'react';
import { addMonths, subMonths, addWeeks, subWeeks } from 'date-fns';
import type { CalendarView, WorkoutEvent } from '../types/workout';

interface CalendarState {
  currentDate: Date;
  selectedView: CalendarView;
  selectedEvent: WorkoutEvent | null;
}

type CalendarAction =
  | { type: 'NEXT_PERIOD' }
  | { type: 'PREV_PERIOD' }
  | { type: 'GO_TO_TODAY' }
  | { type: 'SET_VIEW'; payload: CalendarView }
  | { type: 'SELECT_EVENT'; payload: WorkoutEvent }
  | { type: 'CLEAR_EVENT' };

function reducer(state: CalendarState, action: CalendarAction): CalendarState {
  switch (action.type) {
    case 'NEXT_PERIOD':
      return { ...state, currentDate: state.selectedView === 'month' ? addMonths(state.currentDate, 1) : addWeeks(state.currentDate, 1) };
    case 'PREV_PERIOD':
      return { ...state, currentDate: state.selectedView === 'month' ? subMonths(state.currentDate, 1) : subWeeks(state.currentDate, 1) };
    case 'GO_TO_TODAY':
      return { ...state, currentDate: new Date() };
    case 'SET_VIEW':
      return { ...state, selectedView: action.payload };
    case 'SELECT_EVENT':
      return { ...state, selectedEvent: action.payload };
    case 'CLEAR_EVENT':
      return { ...state, selectedEvent: null };
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
  });
  return <CalendarContext.Provider value={{ state, dispatch }}>{children}</CalendarContext.Provider>;
}

export function useCalendar() {
  const ctx = useContext(CalendarContext);
  if (!ctx) throw new Error('useCalendar must be used within CalendarProvider');
  return ctx;
}
