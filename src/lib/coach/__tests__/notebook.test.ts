import { describe, it, expect } from 'vitest';
import {
  confirmInList, diffLines, doctrineBlocks, forgetInList, isNotAvailable, isPendingReflection, messageOf,
  prependToList, readNotebookProfile, readReflections, reflectionChangesContract, resolveInList, restoreToList,
  splitMemories, splitReflections, statusOf,
  type CoachReflection,
} from '../notebook';
import type { CoachMemory } from '../memory';

// The notebook's pure half: what the tabs read off the wire, the list
// transitions they apply optimistically, the line diff a reflection card
// shows and the block parser the doctrine tab renders with. The components
// are thin over these, and this repo has no DOM test environment, so this is
// where the behaviour is pinned; the click flows are in
// e2e/mock/coach-notebook.spec.ts.

function memory(over: Partial<CoachMemory>): CoachMemory {
  return {
    id: 'm1',
    kind: 'note',
    content: 'a fact',
    confidence: null,
    source_kind: 'user',
    created_at: '2026-09-07T08:00:00Z',
    confirmed_at: '2026-09-07T08:00:00Z',
    confirmed: true,
    ...over,
  };
}

function reflection(over: Partial<CoachReflection>): CoachReflection {
  return {
    id: 'r1',
    day: '2026-09-07',
    status: 'pending',
    contract_before: 'Push me on consistency.',
    contract_after: 'Push me on consistency.\nNever program through knee pain.',
    reason: 'You mentioned the knee twice this week.',
    memory_proposal_ids: [],
    created_at: '2026-09-08T03:00:00Z',
    resolved_at: null,
    resolution: null,
    ...over,
  };
}

describe('statusOf / isNotAvailable', () => {
  it('reads the status off an ApiError-shaped failure and nothing else', () => {
    expect(statusOf({ status: 404 })).toBe(404);
    expect(statusOf(new Error('boom'))).toBeNull();
    expect(statusOf(null)).toBeNull();
    expect(statusOf('404')).toBeNull();
  });

  it('treats 404 (no handler yet) and 409 (column-missing) as not available, nothing else', () => {
    expect(isNotAvailable({ status: 404 })).toBe(true);
    expect(isNotAvailable({ status: 409 })).toBe(true);
    expect(isNotAvailable({ status: 500 })).toBe(false);
    expect(isNotAvailable({ status: 401 })).toBe(false);
    expect(isNotAvailable(new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('messageOf', () => {
  it("returns the failure's own text, or the fallback when there is none", () => {
    expect(messageOf(new Error('Memory is full (200 facts) — forget one first'), 'x')).toBe('Memory is full (200 facts) — forget one first');
    expect(messageOf({ status: 409, message: '   ' }, 'fallback')).toBe('fallback');
    expect(messageOf(undefined, 'fallback')).toBe('fallback');
  });
});

describe('readNotebookProfile', () => {
  it('is null when the payload predates lane D01 (no coachContract key at all)', () => {
    expect(readNotebookProfile({ hasAnthropicKey: true, termsCurrent: true })).toBeNull();
    expect(readNotebookProfile(null)).toBeNull();
    expect(readNotebookProfile('nope')).toBeNull();
  });

  it('reads the contract and the opt-in once the key is there, null contract reading as empty', () => {
    expect(readNotebookProfile({ coachContract: null, reflectionOptIn: false }))
      .toEqual({ coachContract: '', reflectionOptIn: false });
    expect(readNotebookProfile({ coachContract: 'Be direct.', reflectionOptIn: true }))
      .toEqual({ coachContract: 'Be direct.', reflectionOptIn: true });
    // A missing opt-in is off, never on.
    expect(readNotebookProfile({ coachContract: '' })?.reflectionOptIn).toBe(false);
  });
});

describe('readReflections', () => {
  it('is null for a payload that is not the list shape (the mock stub answers { ok: true })', () => {
    expect(readReflections({ ok: true })).toBeNull();
    expect(readReflections(undefined)).toBeNull();
  });

  it('keeps the rows that look like reflections', () => {
    const rows = readReflections({ reflections: [reflection({}), { nonsense: true }, null] });
    expect(rows?.map(r => r.id)).toEqual(['r1']);
  });
});

describe('reflections', () => {
  it('is pending until something resolved it', () => {
    expect(isPendingReflection(reflection({}))).toBe(true);
    expect(isPendingReflection(reflection({ resolved_at: '2026-09-08T09:00:00Z', resolution: 'accepted' }))).toBe(false);
  });

  it('knows whether a reflection changes the contract at all', () => {
    expect(reflectionChangesContract(reflection({}))).toBe(true);
    expect(reflectionChangesContract(reflection({ contract_before: 'same', contract_after: 'same' }))).toBe(false);
    expect(reflectionChangesContract(reflection({ contract_before: null, contract_after: '' }))).toBe(false);
  });

  it('splits pending from resolved, each newest first', () => {
    const list = [
      reflection({ id: 'old', created_at: '2026-09-01T03:00:00Z' }),
      reflection({ id: 'done', created_at: '2026-09-05T03:00:00Z', resolved_at: '2026-09-05T09:00:00Z', resolution: 'rejected' }),
      reflection({ id: 'new', created_at: '2026-09-08T03:00:00Z' }),
    ];
    const { pending, resolved } = splitReflections(list);
    expect(pending.map(r => r.id)).toEqual(['new', 'old']);
    expect(resolved.map(r => r.id)).toEqual(['done']);
  });

  it('resolves one in place, leaving the rest alone', () => {
    const list = [reflection({ id: 'a' }), reflection({ id: 'b' })];
    const next = resolveInList(list, 'b', 'accepted', '2026-09-08T09:00:00Z');
    expect(next[0]).toBe(list[0]);
    expect(next[1]).toMatchObject({ id: 'b', status: 'accepted', resolution: 'accepted', resolved_at: '2026-09-08T09:00:00Z' });
  });
});

describe('splitMemories', () => {
  it('puts proposals on one side and groups the confirmed rows by kind in the prompt order, empty kinds left out', () => {
    const list = [
      memory({ id: 'p1', kind: 'injury', confirmed: false, confirmed_at: null, source_kind: 'reflection' }),
      memory({ id: 'n1', kind: 'note' }),
      memory({ id: 'g1', kind: 'goal' }),
      memory({ id: 'i1', kind: 'injury' }),
      memory({ id: 'g2', kind: 'goal' }),
    ];
    const { proposals, confirmed } = splitMemories(list);
    expect(proposals.map(m => m.id)).toEqual(['p1']);
    expect(confirmed.map(g => [g.kind, g.label, g.memories.map(m => m.id)])).toEqual([
      ['injury', 'injuries', ['i1']],
      ['goal', 'goals', ['g1', 'g2']],
      ['note', 'notes', ['n1']],
    ]);
  });

  it('is empty on both sides for an empty list', () => {
    expect(splitMemories([])).toEqual({ proposals: [], confirmed: [] });
  });
});

describe('memory list transitions', () => {
  const pending = memory({ id: 'p', confirmed: false, confirmed_at: null, created_at: '2026-09-09T00:00:00Z' });
  const older = memory({ id: 'o', created_at: '2026-09-01T00:00:00Z' });
  const list = [pending, older];

  it('confirmInList marks the row confirmed where it sits', () => {
    const next = confirmInList(list, 'p', '2026-09-10T00:00:00Z');
    expect(next.map(m => m.id)).toEqual(['p', 'o']);
    expect(next[0]).toMatchObject({ confirmed: true, confirmed_at: '2026-09-10T00:00:00Z' });
    expect(next[1]).toBe(older);
  });

  it('forgetInList drops the row', () => {
    expect(forgetInList(list, 'o').map(m => m.id)).toEqual(['p']);
  });

  it('prependToList puts a new fact on top and never duplicates an id', () => {
    const added = memory({ id: 'a', created_at: '2026-09-11T00:00:00Z' });
    expect(prependToList(list, added).map(m => m.id)).toEqual(['a', 'p', 'o']);
    expect(prependToList([added, ...list], added).map(m => m.id)).toEqual(['a', 'p', 'o']);
  });

  it('restoreToList puts a row back in newest-first order, replacing an optimistic edit of it', () => {
    const middle = memory({ id: 'm', created_at: '2026-09-05T00:00:00Z' });
    expect(restoreToList(list, middle).map(m => m.id)).toEqual(['p', 'm', 'o']);
    // A failed accept: the optimistically-confirmed row goes back to proposed.
    const confirmed = confirmInList(list, 'p', '2026-09-10T00:00:00Z');
    const restored = restoreToList(confirmed, pending);
    expect(restored.map(m => m.id)).toEqual(['p', 'o']);
    expect(restored[0].confirmed).toBe(false);
    // Oldest of all lands last.
    const oldest = memory({ id: 'z', created_at: '2020-01-01T00:00:00Z' });
    expect(restoreToList(list, oldest).map(m => m.id)).toEqual(['p', 'o', 'z']);
  });
});

describe('diffLines', () => {
  it('marks nothing when the two sides match, trailing whitespace aside', () => {
    const { before, after } = diffLines('a\nb ', 'a\nb');
    expect(before.every(l => !l.changed)).toBe(true);
    expect(after.every(l => !l.changed)).toBe(true);
    expect(before.map(l => l.text)).toEqual(['a', 'b ']);
  });

  it('marks an added line on the after side only', () => {
    const { before, after } = diffLines('a\nc', 'a\nb\nc');
    expect(before.map(l => l.changed)).toEqual([false, false]);
    expect(after.map(l => [l.text, l.changed])).toEqual([['a', false], ['b', true], ['c', false]]);
  });

  it('marks a removed line on the before side and a rewritten line on both', () => {
    const { before, after } = diffLines('a\nb\nc', 'a\nB');
    expect(before.map(l => [l.text, l.changed])).toEqual([['a', false], ['b', true], ['c', true]]);
    expect(after.map(l => [l.text, l.changed])).toEqual([['a', false], ['B', true]]);
  });

  it('handles an empty side and CRLF input', () => {
    expect(diffLines('', 'new')).toEqual({ before: [], after: [{ text: 'new', changed: true }] });
    expect(diffLines('gone', '')).toEqual({ before: [{ text: 'gone', changed: true }], after: [] });
    expect(diffLines('a\r\nb', 'a\nb').before.map(l => l.text)).toEqual(['a', 'b']);
  });
});

describe('doctrineBlocks', () => {
  it('turns headings, paragraphs and numbered points into blocks, folding points split by blank lines into one list', () => {
    const text = [
      'Training is the stimulus; recovery is where it becomes fitness.',
      '',
      '## The signals',
      '',
      'The coach reads trends,',
      'not single readings.',
      '',
      '1. Resting heart rate. A rising week is a signal.',
      '',
      '2. HRV trend. Direction beats the number.',
      '',
      '- a bullet',
      '- another',
      '',
      'Closing thought.',
    ].join('\n');
    expect(doctrineBlocks(text)).toEqual([
      { kind: 'paragraph', text: 'Training is the stimulus; recovery is where it becomes fitness.' },
      { kind: 'heading', text: 'The signals' },
      { kind: 'paragraph', text: 'The coach reads trends, not single readings.' },
      { kind: 'list', ordered: true, items: ['Resting heart rate. A rising week is a signal.', 'HRV trend. Direction beats the number.'] },
      { kind: 'list', ordered: false, items: ['a bullet', 'another'] },
      { kind: 'paragraph', text: 'Closing thought.' },
    ]);
  });

  it('is empty for empty text and ignores stray blank lines', () => {
    expect(doctrineBlocks('')).toEqual([]);
    expect(doctrineBlocks('\n\n  \n')).toEqual([]);
  });

  it('parses every real doctrine topic into at least a heading and a paragraph, with no empty block', async () => {
    const { DOCTRINE_TOPICS } = await import('../doctrine/index');
    for (const topic of DOCTRINE_TOPICS) {
      const blocks = doctrineBlocks(topic.text);
      expect(blocks.some(b => b.kind === 'heading'), topic.id).toBe(true);
      expect(blocks.some(b => b.kind === 'paragraph'), topic.id).toBe(true);
      for (const b of blocks) {
        if (b.kind === 'list') expect(b.items.length, topic.id).toBeGreaterThan(0);
        else expect(b.text.length, topic.id).toBeGreaterThan(0);
      }
    }
  });
});
