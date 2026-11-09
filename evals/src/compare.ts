import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import type { RunResult, VerdictStatus } from './types';
import { sha256 } from './report';

// Pure comparison over eval result files. No I/O except the two tree hashes
// at the bottom, which read files and nothing else.
//
// This is the shared half of three consumers that used to each carry their
// own copy of the logic:
//   - evals/diff.ts        prints what moved between two runs
//   - evals/gate.ts        decides whether a candidate run may ship
//   - .claude/workflows/coach-prompt-evolution.js (dominance predicate)

export { promptFileHash, sha256 } from './report';

export const DIMENSIONS = ['constraints', 'progression', 'refusal', 'integrity', 'doctrine'] as const;
export type Dimension = typeof DIMENSIONS[number];

/**
 * The dimensions the gate may fail a PR on.
 *
 * `progression` is deliberately NOT one of them. It is arithmetic over the
 * schedule the coach actually wrote, and on multi-week planning cases the
 * coach writes a materially different schedule every run — measured
 * 2026-09-22, four of seven progression cases flipped between two runs of an
 * identical tree, and a targeted re-run confirmed rather than cleared them.
 * A single-sample baseline cannot gate a dimension that varies that much: it
 * would fail unchanged code, which is how a gate teaches people to ignore it.
 * So progression is computed, printed and attested as ADVISORY, and the
 * nightly API run remains where it is actually read.
 *
 * `doctrine` IS gated, on the same footing as constraints: its checks are
 * regexes over what the coach wrote onto the calendar, a required read, and
 * one week-over-week comparison on a single-week fixture — each a rule the
 * doctrine states outright, with none of progression's multi-week spread.
 * If its first gate runs show it flipping on an unchanged tree, demote it
 * here the way progression was, with the measurement that justifies it.
 */
export const GATED_DIMENSIONS = ['constraints', 'refusal', 'integrity', 'doctrine'] as const satisfies readonly Dimension[];

// ─── Reading result files leniently ──────────────────────────────────────────
//
// A result file on disk is whatever the run that wrote it knew how to write.
// evals/results/ still holds runs from before `promptVersion` and `backend`
// existed, so a *reader* — unlike RunResult, which describes what a run writes
// TODAY — has to allow those fields to be missing rather than assert them and
// read undefined.

export type StoredRunResult = Omit<RunResult, 'promptVersion' | 'backend'> & {
  promptVersion?: string;
  backend?: string;
};

/** The only shape classify() needs. Both StoredRunResult and RunResult satisfy it. */
export interface CaseResultLike {
  id: string;
  verdicts: Partial<Record<Dimension, { status: VerdictStatus } | undefined>>;
  /** Set by run.ts when the case threw: the harness broke, nothing was scored. */
  error?: string;
  transcriptHash?: string;
}

export interface RunResultLike {
  cases: CaseResultLike[];
}

export interface Change {
  caseId: string;
  dim: Dimension;
  from: VerdictStatus | 'absent';
  to: VerdictStatus | 'absent';
}

/** One ungated dimension's movement: reported, never fatal. */
export interface AdvisoryChanges {
  regressions: Change[];
  improvements: Change[];
  otherChanges: Change[];
}

export interface Classification {
  /** pass → fail, and pass → needs-taxonomy, on GATED dimensions only. */
  regressions: Change[];
  /** fail → pass, on gated dimensions only. */
  improvements: Change[];
  /** Every other verdict move on a gated dimension, including absent ↔ present. */
  otherChanges: Change[];
  /** Ungated dimensions, keyed by dimension. Never contributes to a failure,
   *  and never makes a case a re-run suspect. */
  advisory: Partial<Record<Dimension, AdvisoryChanges>>;
  /** Ids in the candidate that the baseline does not have. */
  newCases: string[];
  /** Ids in the baseline that the candidate does not have. */
  missingCases: string[];
  /** Candidate ids whose run broke rather than scored (see isErrored). */
  erroredCases: string[];
}

/**
 * A case that never produced a verdict. run.ts writes `error` and an empty
 * `verdicts` when the harness throws — a broken run, not a coach failure.
 * Reading that as "pass → absent, an other change" (which diff.ts did) is how
 * a suite that half died could look like a quiet, uninteresting diff.
 */
export function isErrored(c: CaseResultLike): boolean {
  return Boolean(c.error) || Object.keys(c.verdicts ?? {}).length === 0;
}

/** Every scored dimension passed and nothing broke. `skipped` does not count against. */
export function casePassed(c: CaseResultLike): boolean {
  if (isErrored(c)) return false;
  return Object.values(c.verdicts).every(v => !v || v.status === 'pass' || v.status === 'skipped');
}

/**
 * What moved from `baseline` to `candidate`.
 *
 * Errors are classified on the CANDIDATE side only: the baseline is a promoted
 * clean run, and the question the gate asks is whether THIS run broke. An
 * errored candidate case is reported once, in `erroredCases`, and its
 * dimensions are not walked — it has no verdicts to compare.
 */
export function classify(
  baseline: RunResultLike,
  candidate: RunResultLike,
  gatedDimensions: readonly Dimension[] = GATED_DIMENSIONS,
): Classification {
  const byIdCandidate = new Map(candidate.cases.map(c => [c.id, c]));
  const baselineIds = new Set(baseline.cases.map(c => c.id));
  const gated = new Set<Dimension>(gatedDimensions);

  const regressions: Change[] = [];
  const improvements: Change[] = [];
  const otherChanges: Change[] = [];
  const advisory: Partial<Record<Dimension, AdvisoryChanges>> = {};
  const advisoryFor = (dim: Dimension): AdvisoryChanges =>
    (advisory[dim] ??= { regressions: [], improvements: [], otherChanges: [] });
  const erroredCases = candidate.cases.filter(isErrored).map(c => c.id);
  const erroredSet = new Set(erroredCases);

  for (const caseBaseline of baseline.cases) {
    const caseCandidate = byIdCandidate.get(caseBaseline.id);
    // Absent from the candidate → missingCases; errored → erroredCases.
    // Either way there are no verdicts to diff.
    if (!caseCandidate || erroredSet.has(caseBaseline.id)) continue;
    for (const dim of DIMENSIONS) {
      const from = caseBaseline.verdicts[dim]?.status ?? 'absent';
      const to = caseCandidate.verdicts[dim]?.status ?? 'absent';
      if (from === to) continue;
      const change: Change = { caseId: caseBaseline.id, dim, from, to };
      // needs-taxonomy is fail-closed, not a pass: a run that stops being able
      // to prove the constraint held is a regression, not a curiosity. The
      // reverse (needs-taxonomy → pass) stays an "other change" — that is a
      // taxonomy edit, which says nothing about the coach.
      const bucket = gated.has(dim)
        ? { regressions, improvements, otherChanges }
        : advisoryFor(dim);
      if (from === 'pass' && (to === 'fail' || to === 'needs-taxonomy')) bucket.regressions.push(change);
      else if (from === 'fail' && to === 'pass') bucket.improvements.push(change);
      else bucket.otherChanges.push(change);
    }
  }

  return {
    regressions,
    improvements,
    otherChanges,
    advisory,
    newCases: candidate.cases.filter(c => !baselineIds.has(c.id)).map(c => c.id),
    missingCases: baseline.cases.filter(c => !byIdCandidate.has(c.id)).map(c => c.id),
    erroredCases,
  };
}

// ─── Majorities ──────────────────────────────────────────────────────────────
//
// A model is not a pure function. On an unchanged tree some cases flip between
// samples: measured 2026-11-09, buried-contraindication [constraints] passed
// one run in four. A verdict taken from one sample is a coin toss on such a
// case, so both halves of the gate decide from a majority of looks: the
// baseline from three full runs (gate.ts promoteBaseline), and a suspect from
// up to three looks (gate.ts runGate). Same function, both sides.

/** How the looks fell on one dimension: status → count ('absent' when a look had no verdict there). */
export type Votes = Partial<Record<VerdictStatus | 'absent', number>>;

export type MajorityLook<T extends CaseResultLike> = T & {
  /** Per dimension, how the looks voted. Only on a case decided from more than one look. */
  votes?: Partial<Record<Dimension, Votes>>;
};

/**
 * One case decided from several looks at it. Per dimension, the status held by
 * a strict majority of the looks that scored wins; an errored look casts no
 * vote; fewer than two scored looks leaves the case errored; no majority (two
 * scored looks that disagree, a three-way split) is `fail` — fail-closed in a
 * candidate. The returned case is the first look that matches the majority on
 * every dimension (so its transcript and detail are a real look's), with any
 * remaining dimension taken from a look that holds the majority status.
 */
export function majorityCase<T extends CaseResultLike>(looks: T[]): MajorityLook<T> {
  if (looks.length === 0) throw new Error('majorityCase needs at least one look');
  if (looks.length === 1) return looks[0];
  const scored = looks.filter(l => !isErrored(l));
  if (scored.length < 2) {
    return { ...looks[0], verdicts: {}, error: `errored in ${looks.length - scored.length} of ${looks.length} looks` };
  }

  const dims = DIMENSIONS.filter(d => scored.some(l => l.verdicts[d]));
  const winner: Partial<Record<Dimension, VerdictStatus | 'absent'>> = {};
  const votes: Partial<Record<Dimension, Votes>> = {};
  for (const dim of dims) {
    const tally: Votes = {};
    for (const look of scored) {
      const status = look.verdicts[dim]?.status ?? 'absent';
      tally[status] = (tally[status] ?? 0) + 1;
    }
    votes[dim] = tally;
    const top = (Object.entries(tally) as Array<[VerdictStatus | 'absent', number]>)
      .find(([, n]) => n > scored.length / 2);
    winner[dim] = top ? top[0] : 'fail';
  }

  const matches = (look: T) => dims.every(d => (look.verdicts[d]?.status ?? 'absent') === winner[d]);
  const representative = scored.find(matches) ?? scored[0];
  const verdicts: CaseResultLike['verdicts'] = {};
  for (const dim of dims) {
    const status = winner[dim]!;
    if (status === 'absent') continue;
    const holder = [representative, ...scored].find(l => l.verdicts[dim]?.status === status);
    verdicts[dim] = holder
      ? holder.verdicts[dim]
      : { status, detail: [`no majority across ${scored.length} looks — recorded as fail`] } as { status: VerdictStatus };
  }
  return { ...representative, verdicts, votes };
}

/** True when two looks already form the majority a third could not change. */
export function looksAgree(a: CaseResultLike, b: CaseResultLike): boolean {
  if (isErrored(a) || isErrored(b)) return isErrored(a) && isErrored(b);
  return DIMENSIONS.every(d => (a.verdicts[d]?.status ?? 'absent') === (b.verdicts[d]?.status ?? 'absent'));
}

/**
 * Whole runs decided case by case — the baseline's construction, and what
 * eval:verify recomputes from the sources a baseline names. Refuses runs that
 * do not score the same case set, and any errored case: a baseline vote must
 * be a verdict, and an errored run is re-run, not out-voted.
 */
export function majorityRun<T extends CaseResultLike>(
  runs: Array<{ cases: T[] }>,
): { ok: true; cases: Array<MajorityLook<T>> } | { ok: false; reason: string } {
  if (runs.length < 3 || runs.length % 2 === 0) {
    return { ok: false, reason: `a majority needs an odd number of runs, at least three (got ${runs.length})` };
  }
  const ids = (r: { cases: T[] }) => r.cases.map(c => c.id).sort().join('\n');
  const first = ids(runs[0]);
  for (const [i, run] of runs.entries()) {
    if (ids(run) !== first) return { ok: false, reason: `run ${i + 1} scores a different case set from run 1` };
    const errored = run.cases.filter(isErrored).map(c => c.id);
    if (errored.length) return { ok: false, reason: `run ${i + 1} has errored case(s): ${errored.join(', ')} — re-run it` };
  }
  const byRun = runs.map(r => new Map(r.cases.map(c => [c.id, c])));
  return { ok: true, cases: runs[0].cases.map(c => majorityCase(byRun.map(m => m.get(c.id)!))) };
}

/** A run narrowed to a set of ids — how the gate re-classifies a targeted re-run. */
export function onlyCases(run: RunResultLike, ids: Iterable<string>): RunResultLike {
  const wanted = new Set(ids);
  return { cases: run.cases.filter(c => wanted.has(c.id)) };
}

// ─── Dominance (the prompt-evolution fitness predicate) ──────────────────────
//
// Lifted verbatim from .claude/workflows/coach-prompt-evolution.js so it can be
// tested. The eval suite is deliberately per-dimension, not a single score, and
// this mirrors that: a variant wins only by DOMINANCE — no dimension gets
// worse, at least one gets strictly better.
//
// The workflow script cannot import this file (workflow scripts are plain JS
// evaluated as a function body with no module resolution and no filesystem
// access), so its copy stays inline and __tests__/compare.test.ts pins the two
// implementations to the same behavior.

export interface DimensionCount {
  pass: number;
  fail: number;
  other?: number;
}
export type DimensionCounts = Record<string, DimensionCount>;

export const rate = (d: DimensionCount): number => (d.pass + d.fail > 0 ? d.pass / (d.pass + d.fail) : 1);

export function dominates(candidate: DimensionCounts, incumbent: DimensionCounts): boolean {
  let strictlyBetter = false;
  for (const dim of Object.keys(incumbent)) {
    const c = candidate[dim];
    if (!c) return false;
    if (rate(c) < rate(incumbent[dim])) return false;
    if (rate(c) > rate(incumbent[dim])) strictlyBetter = true;
  }
  return strictlyBetter;
}

// ─── Tree hashes ─────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
/** The repo root, from this module's own location (evals/src → ../..). */
export const REPO_ROOT = join(here, '..', '..');

/**
 * Files under these directories decide what "correct" means for a run.
 * evals/taxonomy/ is here because the constraints checker resolves exercise
 * names through it: an entry added or moved changes what a constraints verdict
 * means without touching a case or a checker.
 */
const SURFACE_DIRS = ['evals/cases', 'evals/src', 'evals/taxonomy'];

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
}

/**
 * sha256 over the eval surface: every file under evals/cases/, evals/src/ and
 * evals/taxonomy/,
 * in sorted relative-path order, path and content both.
 *
 * promptFileHash answers "did the coach change". This answers "did the
 * QUESTION change" — a loosened rubric, a deleted case, a checker that stopped
 * checking. Both are needed, because a gate attestation that only pinned the
 * prompt could be satisfied by making the test easier.
 */
export function evalSurfaceHash(root: string = REPO_ROOT): string {
  const files: string[] = [];
  for (const dir of SURFACE_DIRS) walk(join(root, dir), files);
  const parts = files
    .map(f => ({ rel: relative(root, f).split('\\').join('/'), full: f }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return sha256(parts.map(p => `${p.rel}\n${readFileSync(p.full, 'utf8')}`).join('\n'));
}
