import { describe, it, expect } from 'vitest';
import { computeTile, type TileResult } from '../engine';
import { MEASURES, specProblem } from '../spec';
import { makeCompletion, makeCtx, makeInputs, makeSet, makeSpec } from './helpers';

// "Sends by grade": clean sends (any stated style but an attempt) counted per
// grade, one series per grade, easiest first; and a pitch is never a set.

function dataOf(result: TileResult) {
  if (!result.ok) throw new Error(`expected ok, got: ${result.problem}`);
  return result.data;
}

const categories = new Map([['def-sport', 'climbing'], ['def-bench', 'strength']]);
const pitch = (date: string, grade: string, style: 'flash' | 'redpoint' | 'follow' | 'attempt' | null, extra = {}) =>
  makeSet(date, 'Sport', grade, null, { definition_id: 'def-sport', ascent_style: style, ...extra });

const setLogs = [
  pitch('2026-09-08', '5.10a', 'redpoint'),
  pitch('2026-09-08', '5.10A ', 'flash'), // same grade, other spelling
  pitch('2026-09-08', '5.11a', 'attempt'), // not a send
  pitch('2026-09-08', '5.9', 'follow'),
  pitch('2026-09-08', '5.11b', null), // no style stated: not a send
  pitch('2026-09-08', '5.12a', 'redpoint', { is_warmup: true }), // a warm-up is no performance
  pitch('2026-09-09', 'V4', 'flash'),
  pitch('2026-09-09', 'hard', 'redpoint'), // unparseable grade
  makeSet('2026-09-08', 'Bench Press', '185', '5', { definition_id: 'def-bench' }),
];

describe('sends-by-grade', () => {
  it('is registered as a pitch measure that counts, closed to non-climbing sports', () => {
    expect(MEASURES['sends-by-grade']).toMatchObject({ source: 'pitch-logs', unitKind: 'count', defaultAgg: 'count' });
    expect(specProblem(makeSpec({ measure: 'sends-by-grade', filters: { sports: ['running'] } }))).toContain('incompatible');
    expect(specProblem(makeSpec({ measure: 'sends-by-grade' }))).toBeNull();
  });

  it('counts clean sends per grade, easiest first, scale by scale', () => {
    const data = dataOf(computeTile(makeSpec({ measure: 'sends-by-grade' }), makeInputs({ setLogs, categories }), makeCtx()));
    expect(data.series.map(s => [s.label, s.points[0]])).toEqual([
      ['5.9', 1],
      ['5.10a', 2],
      ['V4', 1],
    ]);
    expect(data.excluded.unparseable).toBe(1);
  });

  it('keeps to one discipline’s scale with a gradeScale filter', () => {
    const data = dataOf(computeTile(
      makeSpec({ measure: 'sends-by-grade', filters: { gradeScale: 'boulder' } }),
      makeInputs({ setLogs, categories }),
      makeCtx(),
    ));
    expect(data.series.map(s => [s.label, s.points[0]])).toEqual([['Sends by grade · V4', 1]]);
  });

  it('counts a pitch logged without a definition, by its metadata or its climbing event', () => {
    const rows = [
      makeSet('2026-09-10', 'Trad', '5.8', null, { ascent_style: 'redpoint' }),
      makeSet('2026-09-11', 'Trad', '5.8', null, { event_id: 'evt-2026-09-11-outdoor-climbing', ascent_style: 'flash' }),
    ];
    const completions = [makeCompletion('2026-09-11', 'outdoor-climbing')];
    const data = dataOf(computeTile(makeSpec({ measure: 'sends-by-grade' }), makeInputs({ setLogs: rows, completions }), makeCtx()));
    expect(data.series.map(s => [s.label, s.points[0]])).toEqual([['Sends by grade · 5.8', 2]]);
  });
});

describe('set-count leaves pitches out', () => {
  it('counts the bench set and no pitch, by category, metadata or climbing event', () => {
    const rows = [
      ...setLogs,
      makeSet('2026-09-10', 'Trad', '5.8', null, { attempts: 2 }),
      makeSet('2026-09-11', 'Mystery route', '5.10c', null, { event_id: 'evt-2026-09-11-outdoor-climbing' }),
    ];
    const completions = [makeCompletion('2026-09-11', 'outdoor-climbing')];
    const data = dataOf(computeTile(makeSpec({ measure: 'set-count' }), makeInputs({ setLogs: rows, completions, categories }), makeCtx()));
    expect(data.series[0].points[0]).toBe(1);
  });

  it('and the pitches measure still counts every one of them', () => {
    const data = dataOf(computeTile(makeSpec({ measure: 'pitches' }), makeInputs({ setLogs, categories }), makeCtx()));
    // Eight pitches, less the warm-up.
    expect(data.series[0].points[0]).toBe(7);
  });
});
