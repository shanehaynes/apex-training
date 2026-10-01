import { describe, it, expect } from 'vitest';
import {
  ANNOTATION_CHIP_CHARS,
  chipText,
  dayTargetId,
  indexAnnotations,
  isDayId,
  maxSeverity,
  normalizeBody,
  parseAnnotationList,
  sortAnnotations,
  targetProblem,
  type CoachAnnotation,
} from '../annotations';

function note(over: Partial<CoachAnnotation>): CoachAnnotation {
  return {
    id: 'n1',
    target_kind: 'day',
    target_id: '2026-09-08',
    body: 'Deload this week.',
    severity: 'info',
    created_by: 'coach',
    created_at: '2026-09-07T08:00:00Z',
    dismissed_at: null,
    ...over,
  };
}

describe('target ids', () => {
  it('accepts only zero-padded real calendar days', () => {
    expect(isDayId('2026-09-08')).toBe(true);
    expect(isDayId('2026-02-29')).toBe(false); // 2026 is not a leap year
    expect(isDayId('2028-02-29')).toBe(true);
    expect(isDayId('2026-9-8')).toBe(false);
    expect(isDayId('2026-13-01')).toBe(false);
    expect(isDayId('20260908')).toBe(false);
  });

  it('formats a Date as the local calendar day', () => {
    expect(dayTargetId(new Date(2026, 8, 8, 23, 30))).toBe('2026-09-08');
    expect(dayTargetId('2026-09-08')).toBe('2026-09-08');
  });

  it('checks each kind against its own id shape', () => {
    expect(targetProblem('day', '2026-09-08')).toBeNull();
    expect(targetProblem('day', 'monday')).toMatch(/YYYY-MM-DD/);
    expect(targetProblem('event', 'w1-mon-stretch__2026-09-07')).toBeNull();
    expect(targetProblem('event', '')).toMatch(/non-empty/);
    expect(targetProblem('event', 'x'.repeat(201))).toMatch(/too long/);
    expect(targetProblem('block', '99999999-8888-4777-8666-555555555555')).toBeNull();
    expect(targetProblem('block', 'base')).toMatch(/uuid/);
    expect(targetProblem('day', 42)).toMatch(/string/);
  });
});

describe('normalizeBody', () => {
  it('trims, and refuses blank, oversized and non-string bodies', () => {
    expect(normalizeBody('  Easy tonight.  ')).toEqual({ body: 'Easy tonight.' });
    expect(normalizeBody('x'.repeat(400))).toEqual({ body: 'x'.repeat(400) });
    expect(normalizeBody('   ')).toHaveProperty('reason');
    expect(normalizeBody('x'.repeat(401))).toHaveProperty('reason');
    expect(normalizeBody(null)).toHaveProperty('reason');
  });
});

describe('chipText', () => {
  it('returns a short body unchanged, collapsed to one line', () => {
    expect(chipText('Deload\n  this week.')).toBe('Deload this week.');
  });

  it('cuts a long body at a word boundary and marks the cut', () => {
    const body = 'Deload this week — load ratio 1.4 is well above the 1.3 ceiling.';
    const text = chipText(body);
    expect(text.length).toBeLessThanOrEqual(ANNOTATION_CHIP_CHARS + 1);
    expect(text.endsWith('…')).toBe(true);
    expect(text).toBe('Deload this week — load ratio 1.4 is…');
  });

  it('cuts mid-token when the only word boundary is too early', () => {
    const text = chipText(`ok ${'x'.repeat(80)}`);
    expect(text).toBe(`ok ${'x'.repeat(37)}…`);
  });
});

describe('ordering', () => {
  const info = note({ id: 'a', severity: 'info', created_at: '2026-09-01T00:00:00Z' });
  const alertLate = note({ id: 'b', severity: 'alert', created_at: '2026-09-03T00:00:00Z' });
  const alertEarly = note({ id: 'c', severity: 'alert', created_at: '2026-09-02T00:00:00Z' });
  const caution = note({ id: 'd', severity: 'caution', created_at: '2026-09-01T00:00:00Z' });

  it('sorts most severe first, then oldest first, without mutating', () => {
    const input = [info, alertLate, alertEarly, caution];
    expect(sortAnnotations(input).map(n => n.id)).toEqual(['c', 'b', 'd', 'a']);
    expect(input.map(n => n.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('names the worst severity, or null for none', () => {
    expect(maxSeverity([info, caution])).toBe('caution');
    expect(maxSeverity([info, alertLate, caution])).toBe('alert');
    expect(maxSeverity([])).toBeNull();
  });
});

describe('indexAnnotations', () => {
  it('buckets live notes by kind and target in reading order, dropping dismissed ones', () => {
    const index = indexAnnotations([
      note({ id: 'd1', target_id: '2026-09-08', severity: 'info' }),
      note({ id: 'd2', target_id: '2026-09-08', severity: 'alert' }),
      note({ id: 'gone', target_id: '2026-09-08', dismissed_at: '2026-09-08T00:00:00Z' }),
      note({ id: 'e1', target_kind: 'event', target_id: 'w1-mon-stretch__2026-09-07' }),
      note({ id: 'b1', target_kind: 'block', target_id: '99999999-8888-4777-8666-555555555555' }),
    ]);
    expect(index.day.get('2026-09-08')?.map(n => n.id)).toEqual(['d2', 'd1']);
    expect(index.day.get('2026-09-09')).toBeUndefined();
    expect(index.event.get('w1-mon-stretch__2026-09-07')?.map(n => n.id)).toEqual(['e1']);
    expect(index.block.get('99999999-8888-4777-8666-555555555555')?.map(n => n.id)).toEqual(['b1']);
  });
});

describe('parseAnnotationList', () => {
  it('reads the API shape', () => {
    const n = note({});
    expect(parseAnnotationList({ annotations: [n] })).toEqual([n]);
  });

  it('reads anything that is not a list as no notes', () => {
    // The mock profile's catch-all answer, an empty body, a stale server.
    expect(parseAnnotationList({ ok: true })).toEqual([]);
    expect(parseAnnotationList(undefined)).toEqual([]);
    expect(parseAnnotationList(null)).toEqual([]);
    expect(parseAnnotationList('annotations')).toEqual([]);
    expect(parseAnnotationList({ annotations: 'nope' })).toEqual([]);
  });

  it('drops malformed rows one at a time and defaults the author', () => {
    const good = note({ id: 'ok' });
    const out = parseAnnotationList({ annotations: [
      null,
      'string',
      { ...good, id: 42 },
      { ...good, target_kind: 'week' },
      { ...good, severity: 'panic' },
      { ...good, id: 'legacy', created_by: 'robot', created_at: undefined, dismissed_at: undefined },
      good,
    ] });
    expect(out.map(n => n.id)).toEqual(['legacy', 'ok']);
    expect(out[0]).toMatchObject({ created_by: 'coach', created_at: '', dismissed_at: null });
  });
});
