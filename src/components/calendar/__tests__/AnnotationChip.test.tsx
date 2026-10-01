import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AnnotationChip from '../AnnotationChip';
import type { CoachAnnotation } from '../../../lib/coach/annotations';

// This repo has no DOM test environment (see useChat.persistence.test.ts), so
// the chip is proved at the markup level: what it says, how it is coloured,
// where the full body goes and when the dismiss control exists. The click
// behaviour — dismiss stops the day cell's own click — is proved in the mock
// e2e (e2e/mock/coach-annotations.spec.ts).

const NOTE: CoachAnnotation = {
  id: 'n1',
  target_kind: 'day',
  target_id: '2026-09-08',
  body: 'Deload this week — load ratio 1.4 is well above the 1.3 ceiling.',
  severity: 'caution',
  created_by: 'coach',
  created_at: '2026-09-07T08:00:00Z',
  dismissed_at: null,
};

describe('AnnotationChip', () => {
  it('shows the first ~40 characters, carries the full body as the title, and colours by severity', () => {
    const html = renderToStaticMarkup(<AnnotationChip annotation={NOTE} onDismiss={() => {}} />);
    expect(html).toContain('class="annotation-chip annotation-chip--caution"');
    expect(html).toContain('data-severity="caution"');
    expect(html).toContain('<span class="annotation-chip__text">Deload this week — load ratio 1.4 is…</span>');
    expect(html).toContain(`title="${NOTE.body}"`);
    expect(html).toContain('aria-label="Dismiss coach note"');
  });

  it('renders no dismiss control without a handler', () => {
    const html = renderToStaticMarkup(<AnnotationChip annotation={NOTE} />);
    expect(html).not.toContain('annotation-chip__dismiss');
  });

  it('shows the whole body in full mode', () => {
    const html = renderToStaticMarkup(<AnnotationChip annotation={NOTE} full />);
    expect(html).toContain('annotation-chip--full');
    expect(html).toContain(`<span class="annotation-chip__text">${NOTE.body}</span>`);
  });

  it('marks info and alert notes with their own severity class', () => {
    for (const severity of ['info', 'alert'] as const) {
      const html = renderToStaticMarkup(<AnnotationChip annotation={{ ...NOTE, severity }} />);
      expect(html).toContain(`annotation-chip--${severity}`);
    }
  });
});
