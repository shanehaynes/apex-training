import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REPO_ROOT,
  DIMENSIONS,
  GATED_DIMENSIONS,
  casePassed,
  classify,
  dominates,
  evalSurfaceHash,
  isErrored,
  onlyCases,
  rate,
  type RunResultLike,
} from '../src/compare';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): RunResultLike =>
  JSON.parse(readFileSync(join(HERE, 'fixtures', name), 'utf8'));

describe('classify', () => {
  const baseline = fixture('baseline-clean.json');

  it('finds nothing when nothing moved', () => {
    const r = classify(baseline, fixture('candidate-clean.json'));
    expect(r).toEqual({
      regressions: [], improvements: [], otherChanges: [], advisory: {},
      newCases: [], missingCases: [], erroredCases: [],
    });
  });

  it('reports pass → fail as a regression', () => {
    const r = classify(baseline, fixture('candidate-regression.json'));
    expect(r.regressions).toEqual([
      { caseId: 'buried-contraindication', dim: 'constraints', from: 'pass', to: 'fail' },
    ]);
    expect(r.otherChanges).toEqual([]);
  });

  it('reports pass → needs-taxonomy as a regression, not a curiosity', () => {
    // needs-taxonomy is fail-closed: the run stopped being able to PROVE the
    // constraint held. Filed as an "other change" it would scroll past.
    const r = classify(baseline, fixture('candidate-needs-taxonomy.json'));
    expect(r.regressions).toEqual([
      { caseId: 'buried-contraindication', dim: 'constraints', from: 'pass', to: 'needs-taxonomy' },
    ]);
  });

  it('counts a case with an error as errored, not as an other change', () => {
    // The bug this function exists to fix: diff.ts read the missing verdicts of
    // a crashed case as pass → absent and filed it under "Other changes", so a
    // suite that half died looked like a quiet diff.
    const r = classify(baseline, fixture('candidate-errored.json'));
    expect(r.erroredCases).toEqual(['buried-contraindication']);
    expect(r.otherChanges).toEqual([]);
    expect(r.regressions).toEqual([]);
  });

  it('counts a case with empty verdicts as errored even with no error field', () => {
    const candidate: RunResultLike = { cases: [{ id: 'deload-week', verdicts: {} }] };
    expect(isErrored(candidate.cases[0])).toBe(true);
    expect(classify(baseline, candidate).erroredCases).toEqual(['deload-week']);
  });

  it('reports fail → pass as an improvement', () => {
    const r = classify(fixture('candidate-regression.json'), baseline);
    expect(r.improvements).toEqual([
      { caseId: 'buried-contraindication', dim: 'constraints', from: 'fail', to: 'pass' },
    ]);
  });

  it('names ids present on one side only', () => {
    expect(classify(baseline, fixture('candidate-new-case-passing.json')).newCases)
      .toEqual(['post-op-override']);
    expect(classify(baseline, fixture('candidate-missing-case.json')).missingCases)
      .toEqual(['unsafe-volume-insist']);
  });

  it('reads a legacy result file that predates promptVersion and backend', () => {
    const legacy = fixture('legacy-api-run.json');
    expect(() => classify(legacy, baseline)).not.toThrow();
    expect(classify(legacy, baseline).regressions).toEqual([]);
  });
});

describe('casePassed', () => {
  it('is true only when every scored dimension passed', () => {
    expect(casePassed({ id: 'a', verdicts: { constraints: { status: 'pass' } } })).toBe(true);
    expect(casePassed({ id: 'a', verdicts: { constraints: { status: 'fail' } } })).toBe(false);
    expect(casePassed({ id: 'a', verdicts: { constraints: { status: 'needs-taxonomy' } } })).toBe(false);
    expect(casePassed({ id: 'a', verdicts: {}, error: 'boom' })).toBe(false);
  });

  it('does not count a skipped dimension against the case', () => {
    expect(casePassed({ id: 'a', verdicts: { constraints: { status: 'pass' }, refusal: { status: 'skipped' } } }))
      .toBe(true);
  });
});

describe('onlyCases', () => {
  it('narrows a run to the named ids', () => {
    const narrowed = onlyCases(fixture('baseline-clean.json'), ['deload-week']);
    expect(narrowed.cases.map(c => c.id)).toEqual(['deload-week']);
  });
});

describe('evalSurfaceHash', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'apex-surface-'));
    mkdirSync(join(root, 'evals', 'cases'), { recursive: true });
    mkdirSync(join(root, 'evals', 'src', 'checkers'), { recursive: true });
    mkdirSync(join(root, 'evals', 'taxonomy'), { recursive: true });
    writeFileSync(join(root, 'evals', 'cases', 'constraints.ts'), 'export const A = 1;\n');
    writeFileSync(join(root, 'evals', 'src', 'checkers', 'constraints.ts'), 'export const B = 2;\n');
    writeFileSync(join(root, 'evals', 'taxonomy', 'movement-patterns.json'), '{"squat":["back squat"]}\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('is stable across calls', () => {
    expect(evalSurfaceHash(root)).toBe(evalSurfaceHash(root));
  });

  it('changes when a rubric is loosened', () => {
    const before = evalSurfaceHash(root);
    writeFileSync(join(root, 'evals', 'src', 'checkers', 'constraints.ts'), 'export const B = 3;\n');
    expect(evalSurfaceHash(root)).not.toBe(before);
  });

  it('changes when the taxonomy is edited', () => {
    // The constraints checker resolves exercise names through the taxonomy, so
    // an entry added there changes what a constraints verdict means without
    // any case or checker moving.
    const before = evalSurfaceHash(root);
    writeFileSync(join(root, 'evals', 'taxonomy', 'movement-patterns.json'), '{"squat":["back squat","goblet squat"]}\n');
    expect(evalSurfaceHash(root)).not.toBe(before);
  });

  it('changes when a case is deleted', () => {
    const before = evalSurfaceHash(root);
    rmSync(join(root, 'evals', 'cases', 'constraints.ts'));
    expect(evalSurfaceHash(root)).not.toBe(before);
  });

  it('changes when a file moves but its content does not', () => {
    // The path is hashed as well as the content, so a rename is visible.
    const before = evalSurfaceHash(root);
    rmSync(join(root, 'evals', 'cases', 'constraints.ts'));
    writeFileSync(join(root, 'evals', 'cases', 'renamed.ts'), 'export const A = 1;\n');
    expect(evalSurfaceHash(root)).not.toBe(before);
  });

  it('hashes the real tree without throwing', () => {
    expect(evalSurfaceHash()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('dominance', () => {
  const dims = (pass: number, fail: number) => ({ pass, fail, other: 0 });

  it('requires no dimension to get worse and one to get strictly better', () => {
    const incumbent = { constraints: dims(8, 2), refusal: dims(9, 1) };
    expect(dominates({ constraints: dims(9, 1), refusal: dims(9, 1) }, incumbent)).toBe(true);
    expect(dominates({ constraints: dims(8, 2), refusal: dims(9, 1) }, incumbent)).toBe(false);
    expect(dominates({ constraints: dims(10, 0), refusal: dims(8, 2) }, incumbent)).toBe(false);
  });

  it('refuses a candidate that dropped a dimension entirely', () => {
    expect(dominates({ constraints: dims(10, 0) }, { constraints: dims(8, 2), refusal: dims(9, 1) }))
      .toBe(false);
  });

  it('treats an unscored dimension as a perfect rate', () => {
    expect(rate({ pass: 0, fail: 0 })).toBe(1);
  });
});

describe('the prompt-evolution workflow and compare.ts stay one predicate', () => {
  // The workflow script is plain JS evaluated as a function body with no module
  // resolution and no filesystem access — it cannot import this file. So its
  // copy stays inline and this test is the seam: edit one without the other and
  // it fails here, which is the whole reason the copy is tolerable.
  const source = readFileSync(join(REPO_ROOT, '.claude', 'workflows', 'coach-prompt-evolution.js'), 'utf8');

  const lifted = (() => {
    const rateSrc = source.match(/^const rate = .*$/m);
    const dominatesSrc = source.match(/^function dominates\([\s\S]*?\n\}/m);
    expect(rateSrc, 'the workflow still defines `const rate = ...`').toBeTruthy();
    expect(dominatesSrc, 'the workflow still defines `function dominates(...)`').toBeTruthy();
    // eslint-disable-next-line no-new-func
    return new Function(`${rateSrc?.[0]}\n${dominatesSrc?.[0]}\nreturn { rate, dominates };`)() as {
      rate: typeof rate;
      dominates: typeof dominates;
    };
  })();

  const TABLE: Array<[Record<string, { pass: number; fail: number }>, Record<string, { pass: number; fail: number }>]> = [
    [{ a: { pass: 9, fail: 1 } }, { a: { pass: 8, fail: 2 } }],
    [{ a: { pass: 8, fail: 2 } }, { a: { pass: 8, fail: 2 } }],
    [{ a: { pass: 7, fail: 3 } }, { a: { pass: 8, fail: 2 } }],
    [{ a: { pass: 10, fail: 0 }, b: { pass: 0, fail: 5 } }, { a: { pass: 8, fail: 2 }, b: { pass: 3, fail: 2 } }],
    [{ b: { pass: 9, fail: 1 } }, { a: { pass: 8, fail: 2 }, b: { pass: 8, fail: 2 } }],
    [{ a: { pass: 0, fail: 0 } }, { a: { pass: 0, fail: 0 } }],
    [{ a: { pass: 1, fail: 0 } }, { a: { pass: 0, fail: 0 } }],
  ];

  it.each(TABLE)('agrees on dominates(%j, %j)', (candidate, incumbent) => {
    expect(lifted.dominates(candidate, incumbent)).toBe(dominates(candidate, incumbent));
  });

  it.each([
    { pass: 0, fail: 0 }, { pass: 3, fail: 1 }, { pass: 0, fail: 4 }, { pass: 5, fail: 0 },
  ])('agrees on rate(%j)', (d) => {
    expect(lifted.rate(d)).toBe(rate(d));
  });
});

// ─── Gated vs advisory dimensions ────────────────────────────────────────────

describe('classify: gatedDimensions', () => {
  const run = (verdicts: Record<string, Record<string, string>>): RunResultLike => ({
    cases: Object.entries(verdicts).map(([id, dims]) => ({
      id,
      verdicts: Object.fromEntries(
        Object.entries(dims).map(([d, s]) => [d, { status: s as never }])),
    })),
  });

  const before = run({ c1: { constraints: 'pass', progression: 'pass', refusal: 'pass' } });

  it('files a progression pass → fail as ADVISORY, not a regression', () => {
    const r = classify(before, run({ c1: { constraints: 'pass', progression: 'fail', refusal: 'pass' } }));
    expect(r.regressions).toEqual([]);
    expect(r.advisory.progression?.regressions).toEqual([
      { caseId: 'c1', dim: 'progression', from: 'pass', to: 'fail' },
    ]);
  });

  it('still files a constraints pass → fail as a regression', () => {
    const r = classify(before, run({ c1: { constraints: 'fail', progression: 'pass', refusal: 'pass' } }));
    expect(r.regressions).toEqual([
      { caseId: 'c1', dim: 'constraints', from: 'pass', to: 'fail' },
    ]);
    expect(r.advisory).toEqual({});
  });

  it('sorts refusal and integrity into the gated buckets, progression into advisory', () => {
    const r = classify(
      run({ c1: { constraints: 'pass', progression: 'pass', refusal: 'fail', integrity: 'pass' } }),
      run({ c1: { constraints: 'pass', progression: 'fail', refusal: 'pass', integrity: 'fail' } }),
    );
    expect(r.improvements).toEqual([{ caseId: 'c1', dim: 'refusal', from: 'fail', to: 'pass' }]);
    expect(r.regressions).toEqual([{ caseId: 'c1', dim: 'integrity', from: 'pass', to: 'fail' }]);
    expect(r.advisory.progression?.regressions).toHaveLength(1);
    expect(r.advisory.constraints).toBeUndefined();
  });

  it('gates every dimension when asked — how diff.ts keeps its old meaning', () => {
    const r = classify(
      before,
      run({ c1: { constraints: 'pass', progression: 'fail', refusal: 'pass' } }),
      DIMENSIONS,
    );
    expect(r.regressions).toEqual([
      { caseId: 'c1', dim: 'progression', from: 'pass', to: 'fail' },
    ]);
    expect(r.advisory).toEqual({});
  });

  it('names the gated set explicitly, so widening it is a deliberate edit', () => {
    expect([...GATED_DIMENSIONS]).toEqual(['constraints', 'refusal', 'integrity']);
    expect(GATED_DIMENSIONS).not.toContain('progression');
  });
});
