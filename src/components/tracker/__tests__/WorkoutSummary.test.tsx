import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkoutSummary from '../WorkoutSummary';
import type { WorkoutEvent } from '../../../types/workout';
import type { CoachStatus } from '../../../hooks/useWorkoutSession';

// No DOM test environment here (see notebook.test.tsx): the summary's footer
// is proved at the markup level — both buttons, in order, the ask one
// marked for the e2e that clicks it (e2e/mock/ask-coach.spec.ts). The
// dispatch behind onAskCoach lives in TrackerView and is proved there.

const event = {
  id: 'w1-mon-stretch__2026-06-22', date: '2026-06-22', title: 'Nightly Stretch — Upper', type: 'stretch',
} as unknown as WorkoutEvent;

function render(over: { coachStatus?: CoachStatus; coachText?: string | null; onAskCoach?: (() => void) | undefined } = {}) {
  return renderToStaticMarkup(
    <WorkoutSummary
      event={event}
      accentColor="#123456"
      durationSeconds={1800}
      groups={[]}
      prs={[]}
      score={null}
      scoreRecord={null}
      coachText={over.coachText === undefined ? 'Solid session.' : over.coachText}
      coachStatus={over.coachStatus ?? 'ready'}
      onClose={() => {}}
      onDone={() => {}}
      onAskCoach={'onAskCoach' in over ? over.onAskCoach : () => {}}
    />,
  );
}

describe('WorkoutSummary footer', () => {
  it('offers Back to calendar and Ask the coach about this session', () => {
    const html = render();
    expect(html).toContain('Nightly Stretch — Upper · Mon, Jun 22 · 30 min');
    const done = html.indexOf('Back to calendar');
    const ask = html.indexOf('data-testid="ask-coach-summary"');
    expect(done).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(done);
    expect(html).toContain('Ask the coach about this session');
    // The ask is the secondary: the accent as an outline, not a fill — and
    // enabled once the coach's summary is saved.
    expect(html).toMatch(/data-testid="ask-coach-summary" style="[^"]*border:1px solid #123456/);
    expect(html).not.toMatch(/data-testid="ask-coach-summary"[^>]*disabled/);
  });

  it('holds the ask while the coach\'s summary is still streaming, and shows the words so far', () => {
    const html = render({ coachStatus: 'loading', coachText: 'Solid sess' });
    expect(html).toMatch(/data-testid="ask-coach-summary"[^>]*disabled=""/);
    expect(html).toContain("Available once the coach&#x27;s summary is saved");
    expect(html).toContain('<p class="tracker-summary__coach-text">Solid sess</p>');
    expect(html).not.toContain('Your coach is writing');
  });

  it('shows the placeholder before the first word arrives', () => {
    const html = render({ coachStatus: 'loading', coachText: null });
    expect(html).toContain('Your coach is writing…');
    expect(html).toMatch(/data-testid="ask-coach-summary"[^>]*disabled=""/);
  });

  it('lets the ask through when the summary is unavailable — nothing more will be saved', () => {
    const html = render({ coachStatus: 'unavailable', coachText: null });
    expect(html).toContain('unavailable right now');
    expect(html).not.toMatch(/data-testid="ask-coach-summary"[^>]*disabled/);
  });

  it('has no ask where the coach pane cannot show (no onAskCoach)', () => {
    const html = render({ onAskCoach: undefined });
    expect(html).toContain('Back to calendar');
    expect(html).not.toContain('ask-coach-summary');
  });
});
