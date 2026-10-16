import { describe, it, expect } from 'vitest';
import { calendarReducer, isAnyOverlayOpen, type CalendarAction, type CalendarState } from '../calendar';
import type { WorkoutEvent } from '../../types/workout';
import type { Meal } from '../../types/nutrition';

// The setup nudge hides behind isAnyOverlayOpen. Every OPEN_* action must
// trip it — the hand-kept list it replaced missed weekly review and analytics.

const closed: CalendarState = {
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
  historyOpen: false,
  askCoach: null,
};

const event = { id: 'w1', date: '2026-06-22' } as WorkoutEvent;
const meal = { id: 'm1', date: '2026-06-22' } as Meal;

const opens: CalendarAction[] = [
  { type: 'SELECT_EVENT', payload: event },
  { type: 'START_TRACKING', payload: event },
  { type: 'OPEN_EVENT_EDITOR', payload: event },
  { type: 'OPEN_MEAL_EDITOR', payload: meal },
  { type: 'OPEN_LIBRARY' },
  { type: 'OPEN_PROFILE' },
  { type: 'OPEN_BLOCKS' },
  { type: 'OPEN_WEEKLY_REVIEW' },
  { type: 'OPEN_ANALYTICS' },
  { type: 'OPEN_NOTEBOOK' },
  { type: 'OPEN_HISTORY' },
  { type: 'OPEN_COMPOSER', payload: '2026-06-22' },
  { type: 'OPEN_MEAL_COMPOSER', payload: '2026-06-22' },
  { type: 'SELECT_DAY', payload: '2026-06-22' },
];

describe('isAnyOverlayOpen', () => {
  it('is false with nothing open', () => {
    expect(isAnyOverlayOpen(closed)).toBe(false);
  });

  it.each(opens.map(a => [a.type, a] as const))('is true after %s', (_type, action) => {
    expect(isAnyOverlayOpen(calendarReducer(closed, action))).toBe(true);
  });

  it('ignores navigation and the ask-the-coach pin', () => {
    const moved = calendarReducer(calendarReducer(closed, { type: 'NEXT_PERIOD' }), { type: 'SET_VIEW', payload: 'week' });
    expect(isAnyOverlayOpen(moved)).toBe(false);
  });
});
