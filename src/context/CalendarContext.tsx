import { useEffect, useMemo, useReducer } from 'react';
import { registerAgentState } from '../dev/agentBridge';
import { now } from '../lib/clock';
import { CalendarContext, calendarReducer } from './calendar';

export function CalendarProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(calendarReducer, {
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
    weeklyReviewOpen: false,
    analyticsOpen: false,
    notebookOpen: false,
    askCoach: null,
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
      weeklyReviewOpen: state.weeklyReviewOpen,
      analyticsOpen: state.analyticsOpen,
      notebookOpen: state.notebookOpen,
      askCoachEventId: state.askCoach?.eventId ?? null,
    }));
  }, [state]);

  // dispatch is stable, so the value identity tracks state alone.
  const value = useMemo(() => ({ state, dispatch }), [state]);

  return <CalendarContext.Provider value={value}>{children}</CalendarContext.Provider>;
}
