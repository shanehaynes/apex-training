import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkoutSummary from '../WorkoutSummary';
import type { WorkoutEvent } from '../../../types/workout';

// No DOM test environment here (see notebook.test.tsx): the summary's footer
// is proved at the markup level — both buttons, in order, the ask one
// marked for the e2e that clicks it (e2e/mock/ask-coach.spec.ts). The
// dispatch behind onAskCoach lives in TrackerView and is proved there.

const event = {
  id: 'w1-mon-stretch__2026-06-22', date: '2026-06-22', title: 'Nightly Stretch — Upper', type: 'stretch',
} as unknown as WorkoutEvent;

describe('WorkoutSummary footer', () => {
  it('offers Back to calendar and Ask the coach about this session', () => {
    const html = renderToStaticMarkup(
      <WorkoutSummary
        event={event}
        accentColor="#123456"
        durationSeconds={1800}
        groups={[]}
        prs={[]}
        score={null}
        scoreRecord={null}
        coachText="Solid session."
        coachStatus="ready"
        onClose={() => {}}
        onDone={() => {}}
        onAskCoach={() => {}}
      />,
    );
    expect(html).toContain('Nightly Stretch — Upper · Mon, Jun 22 · 30 min');
    const done = html.indexOf('Back to calendar');
    const ask = html.indexOf('data-testid="ask-coach-summary"');
    expect(done).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(done);
    expect(html).toContain('Ask the coach about this session');
    // The ask is the secondary: the accent as an outline, not a fill.
    expect(html).toMatch(/data-testid="ask-coach-summary" style="[^"]*border:1px solid #123456/);
  });
});
