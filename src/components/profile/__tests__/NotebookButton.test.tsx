import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotebookButtonView, pendingProposalCount } from '../NotebookButton';

// No DOM test environment in this repo: the badge is proved at the markup
// level, the count by the pure helper the component feeds it through.

const render = (count: number | null) => renderToStaticMarkup(<NotebookButtonView count={count} onOpen={() => {}} />);

describe('NotebookButtonView', () => {
  it('shows no badge at zero, while loading, or after a failure', () => {
    for (const count of [0, null]) {
      const html = render(count);
      expect(html).toContain('Open the notebook');
      expect(html).not.toContain('notebook-badge');
    }
  });

  it('shows the count with an aria-label when proposals are waiting', () => {
    const html = render(3);
    expect(html).toContain('data-testid="notebook-badge"');
    expect(html).toContain('aria-label="3 proposals to review"');
    expect(html).toMatch(/>3<\/span>/);
    expect(html).toContain('data-testid="open-notebook"');
  });

  it('says "proposal" for one and caps the visible number', () => {
    expect(render(1)).toContain('aria-label="1 proposal to review"');
    const many = render(140);
    expect(many).toContain('>99+</span>');
    expect(many).toContain('aria-label="140 proposals to review"');
  });
});

describe('pendingProposalCount', () => {
  const reflection = (id: string, resolved: boolean) => ({
    id,
    day: '2026-10-13',
    status: resolved ? 'accepted' : 'pending',
    resolution: resolved ? 'accepted' : null,
    resolved_at: resolved ? '2026-10-14T08:00:00Z' : null,
    created_at: '2026-10-14T03:00:00Z',
  });

  it('counts unresolved reflections and unconfirmed memories, nothing else', () => {
    const reflections = { reflections: [reflection('r1', false), reflection('r2', true), reflection('r3', false)] };
    const memories = { memories: [{ id: 'm1', confirmed: false }, { id: 'm2', confirmed: true }] };
    expect(pendingProposalCount(reflections, memories)).toBe(3);
  });

  it('reads a payload without the lists as zero', () => {
    expect(pendingProposalCount({ ok: true }, { ok: true })).toBe(0);
    expect(pendingProposalCount(null, undefined)).toBe(0);
  });
});
