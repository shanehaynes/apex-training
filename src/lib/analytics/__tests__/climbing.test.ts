import { describe, it, expect } from 'vitest';
import { computeTile, type TileResult } from '../engine';
import { makeCompletion, makeCtx, makeInputs, makeSet, makeSpec } from './helpers';

// A pitch is never a set: set-count leaves out every row the pitches measure
// counts.

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
