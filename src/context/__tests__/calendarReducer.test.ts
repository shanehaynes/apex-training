import { describe, it, expect } from 'vitest';
import { calendarReducer, type CalendarState } from '../calendar';
import type { WorkoutEvent } from '../../types/workout';
import type { AskCoachRequest } from '../../lib/coach/askContext';

// The ask-the-coach pin (D-C08) in the calendar's state machine: set and
// cleared, and what setting it does to the modal.

const event = { id: 'w1-mon-stretch__2026-06-22', date: '2026-06-22', title: 'Nightly Stretch — Upper' } as WorkoutEvent;

const request: AskCoachRequest = {
  kind: 'session', eventId: event.id, date: event.date, title: event.title, source: 'modal',
};

function state(over: Partial<CalendarState> = {}): CalendarState {
  return {
    currentDate: new Date('2026-06-22T08:00:00'),
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
    ...over,
  };
}

describe('calendarReducer — ASK_COACH / CLEAR_ASK_COACH', () => {
  it('ASK_COACH stores the request and closes the workout modal', () => {
    const next = calendarReducer(state({ selectedEvent: event }), { type: 'ASK_COACH', payload: request });
    expect(next.askCoach).toBe(request);
    expect(next.selectedEvent).toBeNull();
  });

  it('ASK_COACH leaves everything else alone — the tracker path has already stopped tracking', () => {
    const before = state({ trackingSession: null, selectedDay: '2026-06-22', notebookOpen: true });
    const next = calendarReducer(before, { type: 'ASK_COACH', payload: { ...request, source: 'tracker' } });
    expect(next).toEqual({ ...before, askCoach: { ...request, source: 'tracker' } });
  });

  it('CLEAR_ASK_COACH clears the pin and nothing else', () => {
    const before = state({ askCoach: request, selectedDay: '2026-06-22' });
    expect(calendarReducer(before, { type: 'CLEAR_ASK_COACH' })).toEqual({ ...before, askCoach: null });
  });

  it('a second ASK_COACH replaces the first', () => {
    const second = { ...request, eventId: 'other', title: 'Other' };
    const next = calendarReducer(state({ askCoach: request }), { type: 'ASK_COACH', payload: second });
    expect(next.askCoach).toBe(second);
  });

  it('CLEAR_EVENT does not touch a pending ask', () => {
    const next = calendarReducer(state({ askCoach: request, selectedEvent: event }), { type: 'CLEAR_EVENT' });
    expect(next.askCoach).toBe(request);
    expect(next.selectedEvent).toBeNull();
  });
});
