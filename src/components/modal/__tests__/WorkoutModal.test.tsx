import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkoutModal from '../WorkoutModal';
import type { WorkoutEvent } from '../../../types/workout';

// The modal's "Ask the coach" button (D-C08), without a DOM: the portal is
// stubbed through, the contexts and hooks are stubbed as the notebook tests
// stub theirs, and the JSX runtime is wrapped to keep the props of every
// element with a data-testid — static markup drops handlers, so the click is
// proved by calling the captured onClick and reading what it dispatched.

const captured = vi.hoisted(() => {
  const props = new Map<string, Record<string, unknown>>();
  type Jsx = (type: unknown, props: Record<string, unknown> | null, ...rest: unknown[]) => unknown;
  const wrap = (orig: Jsx): Jsx => (type, p, ...rest) => {
    if (p && typeof p['data-testid'] === 'string') props.set(p['data-testid'], p);
    return orig(type, p, ...rest);
  };
  return { props, wrap };
});

const modal = vi.hoisted(() => ({
  event: null as WorkoutEvent | null,
  dispatch: vi.fn(),
  coachHidden: false,
}));

vi.mock('react/jsx-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('react/jsx-runtime')>();
  return { ...actual, jsx: captured.wrap(actual.jsx as never), jsxs: captured.wrap(actual.jsxs as never) };
});
vi.mock('react/jsx-dev-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('react/jsx-dev-runtime')>();
  return { ...actual, jsxDEV: captured.wrap(actual.jsxDEV as never) };
});
vi.mock('react-dom', async importOriginal => {
  const actual = await importOriginal<typeof import('react-dom')>();
  return { ...actual, createPortal: (node: unknown) => node };
});
vi.mock('../../../context/calendar', () => ({
  useCalendar: () => ({ state: { selectedEvent: modal.event }, dispatch: modal.dispatch }),
}));
vi.mock('../../../context/schedule', () => ({
  useSchedule: () => ({
    events: [], toggleCompletion: vi.fn(), rescheduleEvent: vi.fn(), updateEvent: vi.fn(), deleteEvent: vi.fn(), deleteOccurrence: vi.fn(),
  }),
}));
vi.mock('../../../hooks/useTip', () => ({ useTip: () => {} }));
vi.mock('../../../hooks/useMediaQuery', () => ({ useMediaQuery: () => modal.coachHidden }));
vi.mock('../SyncMetrics', () => ({ default: () => null }));

const event: WorkoutEvent = {
  id: 'w1-mon-stretch__2026-06-22',
  type: 'stretching',
  title: 'Nightly Stretch — Upper',
  date: '2026-06-22',
  startTime: '9:30 PM',
  endTime: '10:00 PM',
  estimatedDuration: 30,
  description: 'Upper body mobility before bed.',
  exercises: [],
  difficulty: 1,
  tags: [],
  isCompleted: false,
  isRecurring: false,
};

beforeEach(() => {
  modal.event = event;
  modal.coachHidden = false;
  modal.dispatch.mockClear();
  captured.props.clear();
  // createPortal's container argument is read at render; the stubbed portal ignores it.
  vi.stubGlobal('document', { body: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WorkoutModal — Ask the coach', () => {
  it('sits in the completion row and dispatches ASK_COACH with the occurrence id, date, title and source modal', () => {
    const html = renderToStaticMarkup(<WorkoutModal />);
    expect(html).toContain('data-testid="ask-coach"');
    expect(html).toContain('Ask the coach');
    // In the completion row, after Start and Mark as Complete.
    const row = html.slice(html.indexOf('class="modal-completion"'), html.indexOf('class="modal-body"'));
    expect(row.indexOf('Start Workout')).toBeLessThan(row.indexOf('Mark as Complete'));
    expect(row.indexOf('Mark as Complete')).toBeLessThan(row.indexOf('data-testid="ask-coach"'));

    const button = captured.props.get('ask-coach')!;
    (button.onClick as () => void)();
    expect(modal.dispatch).toHaveBeenCalledTimes(1);
    expect(modal.dispatch).toHaveBeenCalledWith({
      type: 'ASK_COACH',
      payload: { kind: 'session', eventId: event.id, date: '2026-06-22', title: 'Nightly Stretch — Upper', source: 'modal' },
    });
  });

  it('is absent at tablet widths, where no coach pane can show', () => {
    modal.coachHidden = true;
    const html = renderToStaticMarkup(<WorkoutModal />);
    expect(html).not.toContain('data-testid="ask-coach"');
    expect(html).toContain('Mark as Complete');
    expect(captured.props.has('ask-coach')).toBe(false);
  });
});
