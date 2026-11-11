import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import TrackerExercise from '../TrackerExercise';
import QuarterPrTicker, { DWELL_MS, FADE_MS, tickerAdvance, tickerDelay, type TickerState } from '../QuarterPrTicker';
import { buildTrackerModel } from '../../../lib/tracking/plan';
import type { QuarterBest } from '../../../lib/tracking/records';
import type { ExerciseCategory } from '../../../types/workout';

// The quarterly best in place of the target column (docs/specs/tracker-quarter-pr).
// Markup-level, like TrackerExercise.test.tsx: there is no DOM environment.

vi.mock('../../../context/schedule', () => ({
  useSchedule: () => ({ definitions: new Map(), updateDefinition: async () => true }),
}));

const BEST: QuarterBest = { weight: '205 lb', reps: '3', duration: '', date: '2026-10-21', quarter: 4 };

function render(quarterBest: QuarterBest | null | undefined, category: ExerciseCategory = 'strength') {
  const tracked = buildTrackerModel({
    id: 'evt', title: 'Push', date: '2026-11-11', type: 'weights',
    exercises: [{ id: 'bench', name: 'Bench Press', category, sets: 3, reps: '5', weight: '185 lb' }],
  } as Parameters<typeof buildTrackerModel>[0])[0].exercises[0];
  return renderToStaticMarkup(
    <TrackerExercise
      tracked={{ ...tracked, quarterBest }}
      accentColor="#123456"
      onSetChange={() => {}}
      onCardioChange={() => {}}
      onCommitSetShadow={() => {}}
      onCommitCardioShadow={() => {}}
      onAddSet={() => {}}
      onRemoveSet={() => {}}
      onSwap={() => {}}
      onNoteChange={() => {}}
    />,
  );
}

// The set rows' target cells, after the head row's.
const plannedCells = (html: string) =>
  [...html.matchAll(/<span class="tracker-set__planned[^"]*">(.*?)<\/span>(?=<div class="tracker-set__inputs")/g)].map(m => m[1]).slice(1);

describe('TrackerExercise — the quarterly best replaces the target (R1, R3)', () => {
  it('heads the column with the quarter and shows the best on the first row only', () => {
    const html = render(BEST);
    expect(html).toContain('Q4 PR');
    expect(html).not.toContain('>target<');
    const cells = plannedCells(html);
    expect(cells).toHaveLength(3);
    expect(cells[0]).toContain('205 lb');
    expect(cells[1]).toBe('');
    expect(cells[2]).toBe('');
    // The plan's per-set label is gone from the rows.
    expect(html).not.toContain('185 lb × 5');
  });

  it('puts the best on the first working set when a warm-up leads', () => {
    const tracked = buildTrackerModel({
      id: 'evt', title: 'Push', date: '2026-11-11', type: 'weights',
      exercises: [{ id: 'bench', name: 'Bench Press', category: 'strength', sets: 3, reps: '5', weight: '185 lb' }],
    } as Parameters<typeof buildTrackerModel>[0])[0].exercises[0];
    const html = renderToStaticMarkup(
      <TrackerExercise
        tracked={{ ...tracked, quarterBest: BEST, sets: tracked.sets.map(s => ({ ...s, isWarmup: s.setNumber === 1 })) }}
        accentColor="#123456"
        onSetChange={() => {}}
        onCardioChange={() => {}}
        onCommitSetShadow={() => {}}
        onCommitCardioShadow={() => {}}
        onAddSet={() => {}}
        onRemoveSet={() => {}}
        onSwap={() => {}}
        onNoteChange={() => {}}
      />,
    );
    const cells = plannedCells(html);
    expect(cells[0]).toBe('');
    expect(cells[1]).toContain('205 lb');
    expect(cells[2]).toBe('');
  });

  it('keeps the plan targets when there is no set this quarter (R5)', () => {
    for (const none of [null, undefined]) {
      const html = render(none);
      expect(html).toContain('>target<');
      expect(plannedCells(html)).toEqual(['185 lb × 5', '185 lb × 5', '185 lb × 5']);
    }
  });

  it('leaves a non-strength exercise on its targets even if a best rides along (R5)', () => {
    const html = render(BEST, 'mobility');
    expect(html).toContain('>target<');
    expect(html).not.toContain('Q4 PR');
  });
});

describe('QuarterPrTicker (R3, R4)', () => {
  it('opens on the first field, with the whole set written once for a screen reader', () => {
    const html = renderToStaticMarkup(
      <QuarterPrTicker fields={['205 lb', '3 reps']} summary="205 lb × 3" description="Best set this quarter (Q4), logged Oct 21: 205 lb × 3" />,
    );
    expect(html).toContain('aria-hidden="true" data-testid="quarter-pr-value">205 lb<');
    expect(html).toContain('<span class="quarter-pr__sr">Best set this quarter (Q4), logged Oct 21: 205 lb × 3</span>');
    expect(html).not.toContain('quarter-pr__value--hidden');
  });

  it('holds a field fully shown for four seconds, fades it out, then fades the next one in, round and round', () => {
    let state: TickerState = { index: 0, shown: true };
    const seen: [number, boolean, number][] = [];
    for (let i = 0; i < 6; i++) {
      seen.push([state.index, state.shown, tickerDelay(state)]);
      state = tickerAdvance(state, 3);
    }
    expect(seen).toEqual([
      [0, true, FADE_MS + DWELL_MS], [0, false, FADE_MS],
      [1, true, FADE_MS + DWELL_MS], [1, false, FADE_MS],
      [2, true, FADE_MS + DWELL_MS], [2, false, FADE_MS],
    ]);
    expect(state).toEqual({ index: 0, shown: true });
    expect(DWELL_MS).toBeGreaterThanOrEqual(3000);
  });
});
