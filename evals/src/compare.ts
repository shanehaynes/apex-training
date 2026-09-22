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

export const DIMENSIONS = ['constraints', 'progression', 'refusal', 'integrity'] as const;
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
 */
export const GATED_DIMENSIONS = ['constraints', 'refusal', 'integrity'] as const satisfies readonly Dimension[];

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
