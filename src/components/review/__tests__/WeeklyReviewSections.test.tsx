import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DoctrineSection, MemoryProposalsSection, NextWeekSection, PhysiologySection, PlanVsDoneSection,
} from '../WeeklyReviewSections';
import { previewForTool } from '../../../lib/coach/preview';
import { findCoachTool } from '../../../lib/coach/tools';
import type { CoachToolContext } from '../../../lib/coach/tools';
import type { WeeklyReviewDocument } from '../../../lib/review/weekly';
import type { WorkoutEvent } from '../../../types/workout';

// The document's sections rendered to markup from one fixture (no DOM
// environment here, the annotationsInViews pattern): what each section
// shows, how a card reads in each accept state, and that a next-week card
// carries the confirm card's own preview. The clicks are proved in
// e2e/mock/weekly-review.spec.ts.

const NEXT_PUSH: WorkoutEvent = {
  id: 'push__2026-09-29', type: 'weights', title: 'Push Day', date: '2026-09-29', startTime: '5:30 PM',
  estimatedDuration: 60, description: '', exercises: [], difficulty: 3, tags: [], isCompleted: false, isRecurring: true,
};

const CTX: CoachToolContext = { definitions: new Map(), events: [NEXT_PUSH], meals: [] };

const DOC: WeeklyReviewDocument = {
  week: { start: '2026-09-21', end: '2026-09-27' },
  planVsDone: {
    planned: 4, completed: 3, minutesPlanned: 300, minutesDone: 250,
    misses: [{ eventId: 'wed-run', title: 'Easy run', date: '2026-09-23', why: 'The day after the long day.' }],
  },
  physiology: { summary: 'Load ratio 1.1 against the four-week average; HRV flat.', flags: ['No strength sets logged', 'Zone 2 minutes down 30%'] },
  doctrine: {
    topic: 'recovery',
    line: 'Prefer the smaller session done to the larger session skipped, in every phase.',
    verdict: 'drifting',
    note: 'The run was skipped rather than shortened.',
  },
  memoryProposals: [{ kind: 'preference', content: 'Prefers evening sessions', why: 'Every completed session started after 5 PM.' }],
  nextWeek: [
    { tool: 'create_event', input: { type: 'cardio', title: 'Easy run', date: '2026-09-30', estimated_duration: 40, start_time: '6:30 AM' }, why: 'Replace the missed run.' },
    { tool: 'update_event', input: { event_id: 'push__2026-09-29', event_title: 'Push Day', changes: { estimated_duration: 45 } }, why: 'Shorter after the long day.' },
  ],
  headline: 'You did the big day and skipped the small one.',
};

const cards = DOC.nextWeek.map(item => ({
  item,
  label: findCoachTool(item.tool)?.displayLabel(item.input, CTX) ?? item.tool,
  preview: previewForTool(item.tool, item.input, CTX),
}));

describe('PlanVsDoneSection', () => {
  it('tables the counts and minutes with the completion rate, and lists misses with their why', () => {
    const html = renderToStaticMarkup(<PlanVsDoneSection plan={DOC.planVsDone} />);
    expect(html).toContain('Plan vs done');
    expect(html).toMatch(/Sessions<\/th><td>4<\/td><td>3<span class="weekly-review__muted"> · 75%<\/span>/);
    expect(html).toMatch(/Minutes<\/th><td>300<\/td><td>250<\/td>/);
    expect(html).toContain('weekly-review__miss-when">Wed Sep 23<');
    expect(html).toContain('weekly-review__miss-title">Easy run<');
    expect(html).toContain('The day after the long day.');
  });

  it('renders no miss list and no rate for an empty week', () => {
    const html = renderToStaticMarkup(<PlanVsDoneSection plan={{ planned: 0, completed: 0, minutesPlanned: 0, minutesDone: 0, misses: [] }} />);
    expect(html).not.toContain('weekly-review__misses');
    expect(html).not.toContain('%');
  });
});

describe('PhysiologySection', () => {
  it('shows the summary and one chip per flag', () => {
    const html = renderToStaticMarkup(<PhysiologySection physiology={DOC.physiology} />);
    expect(html).toContain('HRV flat.');
    expect(html.match(/weekly-review__flag"/g)).toHaveLength(2);
    expect(html).toContain('Zone 2 minutes down 30%');
  });
});

describe('DoctrineSection', () => {
  it('names the topic by its title, quotes the line, and colours the verdict', () => {
    const html = renderToStaticMarkup(<DoctrineSection doctrine={DOC.doctrine} />);
    expect(html).toContain('Recovery, monitoring and load management');
    expect(html).toContain('<blockquote class="weekly-review__quote">Prefer the smaller session done');
    expect(html).toContain('weekly-review__doctrine--drifting');
    expect(html).toContain('data-verdict="drifting">Drifting<');
    expect(html).toContain('The run was skipped rather than shortened.');
  });

  it('says so when there is no check', () => {
    const html = renderToStaticMarkup(<DoctrineSection doctrine={null} />);
    expect(html).toContain('No doctrine check this week.');
    expect(html).not.toContain('blockquote');
  });
});

describe('MemoryProposalsSection', () => {
  it('renders a kind chip, the fact, the why and a Remember button; nothing at all without proposals', () => {
    const html = renderToStaticMarkup(<MemoryProposalsSection proposals={DOC.memoryProposals} states={[]} onRemember={() => {}} />);
    expect(html).toContain('weekly-review__kind">preference<');
    expect(html).toContain('Prefers evening sessions');
    expect(html).toContain('Every completed session started after 5 PM.');
    expect(html).toContain('data-state="idle">');
    expect(html).toContain('Remember</button>');
    expect(renderToStaticMarkup(<MemoryProposalsSection proposals={[]} states={[]} onRemember={() => {}} />)).toBe('');
  });

  it('greys a remembered card out and disables its button', () => {
    const html = renderToStaticMarkup(<MemoryProposalsSection proposals={DOC.memoryProposals} states={['done']} onRemember={() => {}} />);
    expect(html).toContain('weekly-review__card weekly-review__card--done');
    expect(html).toMatch(/<button class="weekly-review__accept weekly-review__accept--done"[^>]*disabled=""/);
    expect(html).toContain('Remembered</button>');
  });
});

describe('NextWeekSection', () => {
  it('labels each card the way the confirm card would and carries the same preview', () => {
    const html = renderToStaticMarkup(<NextWeekSection cards={cards} states={[]} onAccept={() => {}} />);
    expect(html.match(/data-testid="next-week-item"/g)).toHaveLength(2);
    expect(html).toContain('data-tool="create_event"');
    expect(html).toContain('data-kind="event-create"');
    expect(html).toContain('<strong>Wed Sep 30 · 6:30 AM</strong> · 40 min · cardio');
    expect(html).toContain('data-tool="update_event"');
    expect(html).toContain('data-kind="event-update"');
    expect(html).toContain('confirm-preview__field">Duration<');
    expect(html).toContain('confirm-preview__before">60 min<');
    expect(html).toContain('confirm-preview__after">45 min<');
    expect(html).toContain('Update: Push Day');
    expect(html).toContain('Replace the missed run.');
  });

  it('shows the per-card state: busy, accepted, retry', () => {
    const html = renderToStaticMarkup(<NextWeekSection cards={cards} states={['busy', 'error']} onAccept={() => {}} />);
    expect(html).toContain('Applying…</button>');
    expect(html).toContain('Retry</button>');
    const done = renderToStaticMarkup(<NextWeekSection cards={cards} states={['done', 'done']} onAccept={() => {}} />);
    expect(done.match(/weekly-review__card--done/g)).toHaveLength(2);
    expect(done.match(/Accepted<\/button>/g)).toHaveLength(2);
  });

  it('says so when nothing is proposed', () => {
    const html = renderToStaticMarkup(<NextWeekSection cards={[]} states={[]} onAccept={() => {}} />);
    expect(html).toContain('next week stands as scheduled');
  });
});
