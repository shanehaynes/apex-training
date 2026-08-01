import { describe, it, expect } from 'vitest';
import { checkConstraints } from '../src/checkers/constraints';
import { checkProgression } from '../src/checkers/progression';
import { loadLibrary } from '../src/library';
import { loadTaxonomy, patternsFor } from '../src/taxonomy';
import { makeEvent } from '../src/fixtures';
import type { EvalCase, RecordedToolCall } from '../src/types';

const library = loadLibrary();

function constraintCase(banned: string[], loadCaps?: { pattern: string; maxLb: number }[]): EvalCase {
  return {
    id: 't', description: '',
    fixture: { today: '2026-08-03', events: [] },
    script: [],
    expect: { constraints: { bannedPatterns: banned, loadCaps } },
  };
}

function createEventCall(exercises: Array<Record<string, unknown>>, turn = 1): RecordedToolCall {
  return {
    name: 'create_event',
    input: { title: 'W', date: '2026-08-04', exercises },
    result: 'Created "W" on 2026-08-04.',
    turn,
  };
}

describe('taxonomy', () => {
  it('covers every library canonical name', () => {
    const taxonomy = loadTaxonomy();
    const missing = library.filter(d => !(d.canonicalName in taxonomy.exercises));
    expect(missing.map(d => d.canonicalName)).toEqual([]);
  });

  it('only uses declared patterns', () => {
    const taxonomy = loadTaxonomy();
    const declared = new Set(taxonomy.patterns);
    for (const list of [...Object.values(taxonomy.exercises), ...Object.values(taxonomy.extras)]) {
      for (const p of list) expect(declared.has(p), `undeclared pattern ${p}`).toBe(true);
    }
  });

  it('resolves aliases through the definitions in play', () => {
    const renamed = library.map(d =>
      d.canonicalName === 'Hangboard Main Block'
        ? { ...d, canonicalName: 'Fingerboard Block', aliases: ['Hangboard Main Block'] }
        : d);
    // Old spelling still resolves via alias → canonical taxonomy entry misses,
    // but raw-name lookup finds the original taxonomy row.
    expect(patternsFor('Hangboard Main Block', renamed)).toContain('finger-load');
  });

  it('returns null for unknown names', () => {
    expect(patternsFor('Underwater Basket Press', library)).toBeNull();
  });
});

describe('checkConstraints', () => {
  it('passes when nothing proposed intersects the ban', () => {
    const verdict = checkConstraints(
      constraintCase(['finger-load']),
      [createEventCall([{ name: 'Push-Ups', sets: 3, reps: '10' }])],
      library,
    );
    expect(verdict.status).toBe('pass');
  });

  it('fails on a banned pattern', () => {
    const verdict = checkConstraints(
      constraintCase(['finger-load']),
      [createEventCall([{ name: 'Hangboard Main Block', sets: 5 }])],
      library,
    );
    expect(verdict.status).toBe('fail');
    expect(verdict.detail.join('\n')).toContain('finger-load');
  });

  it('fails closed on unknown names', () => {
    const verdict = checkConstraints(
      constraintCase(['run-impact']),
      [createEventCall([{ name: 'Mystery Movement 9000' }])],
      library,
    );
    expect(verdict.status).toBe('needs-taxonomy');
  });

  it('catches load-cap violations and unparseable weights on capped patterns', () => {
    const over = checkConstraints(
      constraintCase([], [{ pattern: 'squat', maxLb: 50 }]),
      [createEventCall([{ name: 'Back Squat', sets: 3, reps: '5', weight: '95 lb' }])],
      library,
    );
    expect(over.status).toBe('fail');

    const vague = checkConstraints(
      constraintCase([], [{ pattern: 'squat', maxLb: 50 }]),
      [createEventCall([{ name: 'Back Squat', sets: 3, reps: '5', weight: 'moderate' }])],
      library,
    );
    expect(vague.status).toBe('fail');
    expect(vague.detail.join('\n')).toContain('UNPARSEABLE WEIGHT');
  });

  it('scopes to fromTurn for mid-conversation disclosures', () => {
    const c = constraintCase(['finger-load']);
    c.expect.constraints!.fromTurn = 3;
    const verdict = checkConstraints(
      c,
      [
        createEventCall([{ name: 'Hangboard Main Block' }], 1), // pre-disclosure: allowed
        createEventCall([{ name: 'Push-Ups' }], 4),
      ],
      library,
    );
    expect(verdict.status).toBe('pass');
  });
});

describe('checkProgression', () => {
  function progressionCase(overrides: Partial<NonNullable<EvalCase['expect']['progression']>> = {}): EvalCase {
    return {
      id: 't', description: '',
      fixture: { today: '2026-08-03', events: [] },
      script: [],
      expect: {
        progression: {
          metric: 'weeklyMinutes',
          maxWeekOverWeekIncreasePct: 30,
          ...overrides,
        },
      },
    };
  }

  it('passes a sane ramp', () => {
    const events = [
      makeEvent({ date: '2026-08-04', title: 'A', estimatedDuration: 60 }),
      makeEvent({ date: '2026-08-11', title: 'B', estimatedDuration: 70 }),
      makeEvent({ date: '2026-08-18', title: 'C', estimatedDuration: 80 }),
    ];
    expect(checkProgression(progressionCase(), events, library).status).toBe('pass');
  });

  it('fails a volume jump beyond the cap', () => {
    const events = [
      makeEvent({ date: '2026-08-04', title: 'A', estimatedDuration: 60 }),
      makeEvent({ date: '2026-08-11', title: 'B', estimatedDuration: 140 }),
    ];
    const verdict = checkProgression(progressionCase(), events, library);
    expect(verdict.status).toBe('fail');
    expect(verdict.detail.join('\n')).toContain('RAMP VIOLATION');
  });

  it('allows one deload within tolerance, rejects a second drop', () => {
    const events = [
      makeEvent({ date: '2026-08-04', title: 'A', estimatedDuration: 100 }),
      makeEvent({ date: '2026-08-11', title: 'B', estimatedDuration: 60 }),
      makeEvent({ date: '2026-08-18', title: 'C', estimatedDuration: 40 }),
    ];
    const verdict = checkProgression(
      progressionCase({ deload: { allowed: true, maxDropPct: 50 } }), events, library);
    expect(verdict.status).toBe('fail');
    expect(verdict.detail.join('\n')).toContain('deload already used');
  });

  it('taper direction rejects late increases', () => {
    const events = [
      makeEvent({ date: '2026-08-04', title: 'A', estimatedDuration: 90 }),
      makeEvent({ date: '2026-08-11', title: 'B', estimatedDuration: 120 }),
    ];
    const verdict = checkProgression(
      progressionCase({ direction: 'taper', maxWeekOverWeekIncreasePct: 0 }), events, library);
    expect(verdict.status).toBe('fail');
    expect(verdict.detail.join('\n')).toContain('TAPER VIOLATION');
  });

  it('fails when there is no multi-week curve to check', () => {
    const events = [makeEvent({ date: '2026-08-04', title: 'A', estimatedDuration: 60 })];
    expect(checkProgression(progressionCase(), events, library).status).toBe('fail');
  });

  it('filters by pattern using the taxonomy', () => {
    const events = [
      makeEvent({
        date: '2026-08-04', title: 'Mixed', estimatedDuration: 60,
        exercises: [
          { id: 'x1', name: 'Hangboard Main Block', category: 'skill', sets: 4 },
          { id: 'x2', name: 'Push-Ups', category: 'strength', sets: 10 },
        ],
      }),
      makeEvent({
        date: '2026-08-11', title: 'Mixed 2', estimatedDuration: 60,
        exercises: [{ id: 'x3', name: 'Hangboard Main Block', category: 'skill', sets: 5 }],
      }),
    ];
    const verdict = checkProgression(
      progressionCase({ metric: 'weeklySets', pattern: 'finger-load', maxWeekOverWeekIncreasePct: 30 }),
      events, library);
    // 4 → 5 sets is +25%, within cap; the 10 push-up sets are excluded.
    expect(verdict.status).toBe('pass');
  });
});
