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
  // GET /api/coach-reflections lists only status 'done' rows; whether one
  // still waits on the athlete is resolved_at and resolution, both null.
  const reflection = (id: string, over: { resolved_at?: string | null; resolution?: string | null } = {}) => ({
    id,
    day: '2026-10-13',
    status: 'done',
    contract_before: 'A',
    contract_after: 'B',
    resolved_at: null,
    resolution: null,
    created_at: '2026-10-14T03:00:00Z',
    ...over,
  });

  it('counts only reflections with neither resolved_at nor resolution', () => {
    const reflections = {
      reflections: [
        reflection('pending'),
        reflection('resolved', { resolved_at: '2026-10-14T08:00:00Z', resolution: 'accepted' }),
        reflection('stamped-only', { resolved_at: '2026-10-14T08:00:00Z' }),
        reflection('resolution-only', { resolution: 'rejected' }),
      ],
    };
    expect(pendingProposalCount(reflections, { memories: [] })).toBe(1);
  });

  it('counts memories the notebook shows as proposals: confirmed false or missing', () => {
    const memories = {
      memories: [
        { id: 'm1', kind: 'injury', content: 'a', confirmed: false },
        { id: 'm2', kind: 'goal', content: 'b', confirmed: true },
        { id: 'm3', kind: 'goal', content: 'c' },
      ],
    };
    expect(pendingProposalCount({ reflections: [] }, memories)).toBe(2);
  });

  it('adds the two', () => {
    const reflections = { reflections: [reflection('r1'), reflection('r2', { resolved_at: 'x', resolution: 'accepted' })] };
    const memories = { memories: [{ id: 'm1', kind: 'injury', content: 'a', confirmed: false }] };
    expect(pendingProposalCount(reflections, memories)).toBe(2);
  });

  it('reads a payload without the lists as zero', () => {
    expect(pendingProposalCount({ ok: true }, { ok: true })).toBe(0);
    expect(pendingProposalCount(null, undefined)).toBe(0);
  });
});
