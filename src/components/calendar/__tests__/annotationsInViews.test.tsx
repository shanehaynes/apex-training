import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useMemo, type ReactNode } from 'react';
import DayView from '../DayView';
import WeekView from '../WeekView';
import { AnnotationMarker } from '../AnnotationChip';
import { ScheduleContext, type ScheduleContextValue } from '../../../context/schedule';
import { CalendarContext, type CalendarContextValue } from '../../../context/calendar';
import { AnnotationsContext, type AnnotationsContextValue } from '../../../context/annotations';
import type { CoachAnnotation } from '../../../lib/coach/annotations';
import type { WorkoutEvent } from '../../../types/workout';

// The day and week views read the annotations context (PR #355's review:
// they used not to, so on a phone — where the day view is the whole calendar
// — every note was invisible). No DOM environment here, so the views are
// rendered to markup under hand-built contexts: what shows where, and which
// chips carry a dismiss. The clicks are proved in e2e/mock/coach-annotations.spec.ts.

const DAY = new Date(2026, 8, 8); // Tue 2026-09-08

const EVENT = {
  id: 'ext-2026-09-08-stretch',
  type: 'stretching',
  title: 'Nightly Stretch — Lower',
  subtitle: 'Core Block + Hamstrings',
  date: '2026-09-08',
  startTime: '9:30 PM',
  estimatedDuration: 29,
  description: '',
  exercises: [],
  difficulty: 2,
  tags: [],
  isCompleted: false,
} as unknown as WorkoutEvent;

const DAY_NOTE: CoachAnnotation = {
  id: 'day-1',
  target_kind: 'day',
  target_id: '2026-09-08',
  body: 'Deload this week — load ratio 1.4 is well above the 1.3 ceiling.',
  severity: 'caution',
  created_by: 'coach',
  created_at: '2026-09-07T07:00:00Z',
  dismissed_at: null,
};

const EVENT_NOTE: CoachAnnotation = {
  id: 'event-1',
  target_kind: 'event',
  target_id: EVENT.id,
  body: 'Skip the spine work if the back is still tight.',
  severity: 'alert',
  created_by: 'coach',
  created_at: '2026-09-07T07:00:00Z',
  dismissed_at: null,
};

function annotationsValue(notes: CoachAnnotation[]): AnnotationsContextValue {
  const of = (kind: CoachAnnotation['target_kind']) => (id: string) =>
    notes.filter(n => n.target_kind === kind && n.target_id === id);
  return {
    annotations: notes,
    range: { from: '2026-08-31', to: '2026-10-04' },
    byDay: of('day'),
    byEvent: of('event'),
    byBlock: of('block'),
    dismiss: async () => {},
    refresh: async () => {},
  };
}

interface Fixture {
  events?: WorkoutEvent[];
  notes?: CoachAnnotation[];
}

const CALENDAR = { state: {}, dispatch: () => {} } as unknown as CalendarContextValue;

function Providers({ events = [], notes = [], children }: Fixture & { children: ReactNode }) {
  const schedule = useMemo(() => ({
    getEventsForDate: (date: Date) => events.filter(e => e.date === localKey(date)),
    toggleCompletion: () => {},
  }) as unknown as ScheduleContextValue, [events]);
  const annotations = useMemo(() => annotationsValue(notes), [notes]);
  return (
    <ScheduleContext.Provider value={schedule}>
      <CalendarContext.Provider value={CALENDAR}>
        <AnnotationsContext.Provider value={annotations}>{children}</AnnotationsContext.Provider>
      </CalendarContext.Provider>
    </ScheduleContext.Provider>
  );
}

function render(node: ReactNode, fixture: Fixture = {}) {
  return renderToStaticMarkup(<Providers {...fixture}>{node}</Providers>);
}

function localKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('DayView', () => {
  it('renders the day notes as whole, dismissable chips above the cards', () => {
    const html = render(<DayView currentDate={DAY} />, { events: [EVENT], notes: [DAY_NOTE] });
    expect(html).toContain('data-testid="day-annotations"');
    // Whole body, not the pill's first ~40 characters.
    expect(html).toContain(`<span class="annotation-chip__text">${DAY_NOTE.body}</span>`);
    expect(html).toContain('annotation-chip--full');
    expect(html).toContain('aria-label="Dismiss coach note"');
    // The strip precedes the card.
    expect(html.indexOf('day-annotations')).toBeLessThan(html.indexOf('day-event-card'));
  });

  it('renders an event note inside its card, below the title row, with dismiss', () => {
    const html = render(<DayView currentDate={DAY} />, { events: [EVENT], notes: [EVENT_NOTE] });
    expect(html).toContain('day-event-card--noted');
    expect(html).toContain('data-testid="event-annotations"');
    expect(html).toContain(`<span class="annotation-chip__text">${EVENT_NOTE.body}</span>`);
    expect(html).toContain('data-severity="alert"');
    expect(count(html, 'aria-label="Dismiss coach note"')).toBe(1);
    expect(html.indexOf('day-event-card__title')).toBeLessThan(html.indexOf('event-annotations'));
    // Not nested in the body button: the button closes before the strip opens.
    const body = html.indexOf('day-event-card__body');
    const strip = html.indexOf('event-annotations');
    expect(html.slice(body, strip)).toContain('</button>');
    // No day strip without a day note.
    expect(html).not.toContain('day-annotations');
  });

  it('keeps the empty state and still shows the day notes on a day with no workouts', () => {
    const html = render(<DayView currentDate={DAY} />, { notes: [DAY_NOTE] });
    expect(html).toContain('No workouts scheduled');
    expect(html).toContain('data-testid="day-annotations"');
    expect(html).not.toContain('day-event-card');
  });

  it('adds nothing when the day has no notes', () => {
    const html = render(<DayView currentDate={DAY} />, { events: [EVENT] });
    expect(html).not.toContain('annotation');
    expect(html).not.toContain('day-event-card--noted');
  });
});

describe('WeekView', () => {
  it('marks the day header and the event block, coloured by severity, with the bodies as the title', () => {
    const html = render(<WeekView currentDate={DAY} />, { events: [EVENT], notes: [DAY_NOTE, EVENT_NOTE] });
    expect(count(html, 'data-testid="day-annotation-marker"')).toBe(1);
    expect(html).toContain(`data-testid="day-annotation-marker" data-severity="caution" role="img" aria-label="1 coach note" title="${DAY_NOTE.body}"`);
    expect(count(html, 'data-testid="event-annotation-marker"')).toBe(1);
    expect(html).toContain(`data-testid="event-annotation-marker" data-severity="alert" role="img" aria-label="1 coach note" title="${EVENT_NOTE.body}"`);
    // The header dot sits beside the weekday, the block dot before its title.
    expect(html).toMatch(/<span class="week-view__dow">Tue<span class="annotation-marker annotation-marker--caution"/);
    expect(html).toMatch(/<span class="week-event__title"><span class="annotation-marker annotation-marker--alert"[^>]*><\/span>Nightly Stretch/);
    // Markers only: the week view has no dismiss.
    expect(html).not.toContain('annotation-chip');
    expect(html).not.toContain('Dismiss coach note');
  });

  it('renders no markers without notes', () => {
    const html = render(<WeekView currentDate={DAY} />, { events: [EVENT] });
    expect(html).not.toContain('annotation-marker');
  });
});

describe('AnnotationMarker', () => {
  it('renders nothing for no notes, and one dot coloured by the worst note otherwise', () => {
    expect(renderToStaticMarkup(<AnnotationMarker notes={[]} testId="event-annotation-marker" />)).toBe('');
    const html = renderToStaticMarkup(
      <AnnotationMarker notes={[{ ...DAY_NOTE, severity: 'info' }, { ...EVENT_NOTE, severity: 'caution' }]} testId="event-annotation-marker" />,
    );
    expect(count(html, '<span')).toBe(1);
    expect(html).toContain('annotation-marker--caution');
    expect(html).toContain('aria-label="2 coach notes"');
    expect(html).toContain(`title="${DAY_NOTE.body}\n${EVENT_NOTE.body}"`);
  });
});
