#!/usr/bin/env node
// How close a CI job runs to its timeout-minutes cap: `ios` or `evals`.
//
//   node scripts/ci-headroom.mjs <ios|evals>
//
// Each cap is the slowest legitimate run seen plus 15 minutes (ios: #503;
// evals: the comment above the job), and each job grows on its own: ios by
// 1–2 minutes a week as UI tests are added, evals with every case and every
// round trip the coach learns to make. Once any run gets within 15 minutes of
// its cap, the fix is to shorten the job, not raise the cap again
// (docs/ios/testing-and-ci.md, evals/README.md). This is what notices. The
// evals cap had no such watch, and it cancelled every real nightly from
// 2026-09-29 to 2026-11-04 before anyone traced it.
//
// The cap is read out of origin/main's ci.yml rather than copied, so the
// report cannot drift from the workflow it watches. Every run of the last
// week is judged against main's cap today, not the one it ran under: after a
// raise, the old cap's kills fall below the line, which is what the raise was
// for.
//
// A run counts when the job's watched step was not skipped (a PR that changes
// no iOS path skips `ios` at job level, so the job reports no steps; one whose
// path decision failed stops at the first step; `evals` runs only on a
// schedule or a dispatch) and the job took at least cap − 15 minutes. A run
// the cap killed ends `cancelled` at or past the cap, so it counts too, and is
// reported as cut off. An evals run whose eval step took under a minute is not
// a timing and is left out: every case came back "credit balance is too low",
// or the key is not set and the step skipped itself, and either way the job
// went green. Every attempt of a re-run is looked at; the count is of runs.
//
// Prints its own lines in the report's style (ACTION at column 0, status
// indented). Exit codes follow scripts/signup-cap-check.mjs: 0 nothing near
// the cap; 1 an ACTION was printed; 2 could not check (gh missing or
// unauthenticated, API down, nothing timed); 64 no such watch.
// scripts/supervisor-report.sh runs it once per watch.

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = '.github/workflows/ci.yml';
export const HEADROOM_MIN = 15;
export const WINDOW_DAYS = 7;
const DAY_MS = 86400 * 1000;

/**
 * The jobs this watches, by their key in ci.yml.
 *
 * `events` null: the job runs on every event, hundreds of runs a week, so only
 * runs long enough to hold a slow job are fetched. A list: the job runs on
 * those events only, about one run a night, so every one is fetched and the
 * all-clear line can say how many were timed and the slowest.
 */
export const WATCHES = {
  ios: {
    step: 'Build and test',
    events: null,
    minStepSeconds: 0,
    noun: 'built ios run',
    runs: 'long CI run(s)',
    fix: 'shorten the job rather than raise the cap (docs/ios/testing-and-ci.md)',
  },
  evals: {
    step: 'Run coach evals',
    events: ['schedule', 'workflow_dispatch'],
    minStepSeconds: 60,
    noun: 'evals run',
    runs: 'scheduled or dispatched run(s)',
    fix: 'shorten the suite rather than raise the cap (evals/README.md)',
    untimed: 'an eval step under a minute is a credit-out or a missing key',
  },
};

function watchOf(key) {
  const watch = Object.hasOwn(WATCHES, key) ? WATCHES[key] : undefined;
  if (!watch) throw new Error(`no CI headroom watch named "${key}" (${Object.keys(WATCHES).join(', ')})`);
  return watch;
}

/**
 * The job's cap and the name the jobs API reports it under, out of the
 * workflow's text. Throws when the shape this check depends on is gone.
 */
export function jobFrom(text, key = 'ios') {
  const { step } = watchOf(key);
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^  ${key}:\\s*(#.*)?$`).test(l));
  if (start < 0) throw new Error(`no \`${key}\` job in ${WORKFLOW}`);
  // The job ends at the next line indented two spaces or less that is not a
  // comment: the next job, or the next top-level key.
  let end = lines.findIndex((l, i) => i > start && /^ {0,2}[^\s#]/.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end);

  // Job-level keys sit at four spaces; a step's own keys are deeper.
  const field = (k) => {
    const line = body.find((l) => l.startsWith(`    ${k}:`));
    return line === undefined ? undefined : scalar(line.slice(`    ${k}:`.length));
  };
  const timeout = field('timeout-minutes');
  if (timeout === undefined) throw new Error(`the \`${key}\` job in ${WORKFLOW} has no timeout-minutes`);
  if (!/^\d+$/.test(timeout)) throw new Error(`the \`${key}\` job's timeout-minutes is not a number (${timeout})`);
  if (!body.some((l) => /^\s+(- )?name:/.test(l) && scalar(l.replace(/^\s+(- )?name:/, '')) === step)) {
    throw new Error(`the \`${key}\` job in ${WORKFLOW} has no "${step}" step`);
  }
  // A job-level `name:` is what the jobs API reports instead of the key.
  const name = field('name') ?? key;
  if (name.includes('${{')) throw new Error(`the \`${key}\` job's name is an expression (${name})`);
  return { cap: Number(timeout), name };
}

/** A one-line YAML scalar: trailing comment and surrounding quotes dropped. */
function scalar(raw) {
  return raw.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
}

/** The jobs API names a matrix job `<name> (<values>)`. */
const isJob = (apiName, name) => apiName === name || apiName.startsWith(`${name} (`);

/** The runs this watch looks at: all of them, or those of its events. */
export function watched(runs, key = 'ios') {
  const { events } = watchOf(key);
  return events ? runs.filter((r) => events.includes(r.event)) : runs;
}

/**
 * Runs whose jobs are worth fetching. A completed run's job cannot have taken
 * longer than the run's own created→updated span (a re-run keeps the run's
 * createdAt), so a shorter run needs no API call. A run still going has no
 * such bound, so it is always fetched. A watch with events fetches every run.
 */
export function candidates(runs, cap, key = 'ios') {
  const floor = (cap - HEADROOM_MIN) * 60 * 1000;
  const mine = watched(runs, key);
  return (watchOf(key).events ? mine : mine.filter((r) => r.status !== 'completed' || Date.parse(r.updatedAt) - Date.parse(r.createdAt) >= floor))
    .map((r) => r.databaseId);
}

const span = (from, to) => (Date.parse(to) - Date.parse(from)) / 1000;

/**
 * Finished attempts of the job whose watched step ran (and, for evals, ran for
 * at least a minute), with the job's duration. `cut` marks a job the cap
 * killed: cancelled at or past it.
 */
export function timed(jobs, cap, key = 'ios', name = key) {
  const { step, minStepSeconds } = watchOf(key);
  return jobs
    .filter((j) => isJob(j.name, name) && j.status === 'completed' && j.started_at && j.completed_at)
    .filter((j) => (j.steps ?? []).some((s) => s.name === step && s.conclusion !== 'skipped' &&
      // A step the cancel caught mid-run may have no end of its own.
      (minStepSeconds === 0 || (s.started_at && span(s.started_at, s.completed_at ?? j.completed_at) >= minStepSeconds))))
    .map((j) => {
      const seconds = span(j.started_at, j.completed_at);
      return { run: j.run_id, attempt: j.run_attempt, conclusion: j.conclusion, seconds, cut: j.conclusion === 'cancelled' && seconds >= cap * 60 };
    });
}

const within = (cap) => (j) => j.seconds >= (cap - HEADROOM_MIN) * 60;

/** Timed attempts that came within HEADROOM_MIN of the cap. */
export function nearCap(jobs, cap, key = 'ios', name = key) {
  return timed(jobs, cap, key, name).filter(within(cap));
}

export function workflowText() {
  try {
    return execFileSync('git', ['show', `origin/main:${WORKFLOW}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // No origin/main ref (a fresh clone with no fetch): the working copy.
    return readFileSync(join(root, WORKFLOW), 'utf8');
  }
}

const execFileP = promisify(execFile);
async function ghCli(args) {
  const { stdout } = await execFileP(process.env.GH || 'gh', args, {
    cwd: root,
    maxBuffer: 32 << 20,
    timeout: 60_000,
  });
  return stdout;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// An execFile error's message is "Command failed: <path> <args>"; what gh
// said (HTTP 401, not logged in) is on its stderr.
const brief = (err) =>
  String((err && String(err.stderr ?? '').trim()) || (err instanceof Error ? err.message : err))
    .split('\n')[0]
    .slice(0, 160);

const minutes = (seconds) => Math.floor(seconds / 60);
const slowestOf = (list) => list.reduce((a, b) => (b.seconds > a.seconds ? b : a));
// Runs, not attempts: re-running failed jobs copies the passed ones into the
// new attempt with the same timestamps, so one slow job can appear once per
// attempt.
const runsIn = (list) => new Set(list.map((h) => h.run)).size;

export async function main({ key = 'ios', gh = ghCli, now = Date.now(), workflow } = {}) {
  const watch = watchOf(key);
  const label = `${key} CI headroom`;
  let job;
  try {
    job = jobFrom(workflow ?? workflowText(), key);
  } catch (err) {
    console.log(`ACTION ${label} is unwatched: ${brief(err)} — update scripts/ci-headroom.mjs to the workflow's shape`);
    return 1;
  }
  const { cap } = job;

  const since = new Date(now - WINDOW_DAYS * DAY_MS).toISOString().replace(/\.\d+Z$/, 'Z');
  let runs;
  try {
    runs = JSON.parse(await gh([
      'run', 'list', '--workflow', 'ci.yml', '--created', `>=${since}`, '--limit', '1000',
      '--json', 'databaseId,status,createdAt,updatedAt,event',
    ]));
  } catch (err) {
    console.log(`   could not list CI runs (${brief(err)}) — ${label} skipped`);
    return 2;
  }

  const ids = candidates(runs, cap, key);
  const pages = await mapLimit(ids, 6, async (id) => {
    try {
      // filter=all: every attempt, so a slow first try that was re-run counts.
      // CI has about ten jobs per attempt, so one page of 100 holds them all.
      return JSON.parse(await gh(['api', `repos/{owner}/{repo}/actions/runs/${id}/jobs?filter=all&per_page=100`])).jobs ?? [];
    } catch {
      return null;
    }
  });
  const unread = pages.filter((p) => p === null).length;
  const all = timed(pages.filter(Boolean).flat(), cap, key, job.name);
  const hits = all.filter(within(cap));

  if (hits.length) {
    const slowest = slowestOf(hits);
    const cut = runsIn(hits.filter((h) => h.cut));
    console.log(
      `ACTION ${key} CI: ${runsIn(hits)} run(s) within ${HEADROOM_MIN} min of the ${cap}-minute cap` +
        `${cut ? `, ${cut} cut off by it` : ''} (slowest ${minutes(slowest.seconds)} min, run ${slowest.run}) — ${watch.fix}`,
    );
  }
  if (unread) {
    console.log(`   ${unread} of ${ids.length} ${watch.runs} could not be read — ${label} partly skipped`);
  }
  if (hits.length) return 1;
  if (unread) return 2;
  if (!watch.events) {
    console.log(`   no ${watch.noun} within ${HEADROOM_MIN} min of the ${cap}-minute cap in ${WINDOW_DAYS} days (${runs.length} CI runs)`);
    return 0;
  }
  // Every run of the watch's events was fetched, so the line can say what was
  // measured. None timed is not an all-clear: nothing was measured.
  const mine = watched(runs, key).length;
  if (!mine) {
    console.log(`   no ${watch.runs} in ${WINDOW_DAYS} days — ${label} unmeasured`);
    return 2;
  }
  if (!all.length) {
    console.log(`   no timed ${watch.noun} in ${WINDOW_DAYS} days (${mine} ${watch.runs}; ${watch.untimed}) — ${label} unmeasured`);
    return 2;
  }
  // A slowest run that was cancelled (by an older, lower cap, or by hand) is a
  // floor on how long the job takes, not a timing, so the line says so.
  const slowest = slowestOf(all);
  const how = slowest.conclusion === 'success' ? '' : `, ${slowest.conclusion}`;
  console.log(
    `   no ${watch.noun} within ${HEADROOM_MIN} min of the ${cap}-minute cap in ${WINDOW_DAYS} days ` +
      `(slowest ${minutes(slowest.seconds)} min${how}; ${runsIn(all)} of ${mine} ${watch.runs} timed)`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const key = process.argv[2];
  if (!key || !Object.hasOwn(WATCHES, key)) {
    console.error(`usage: scripts/ci-headroom.mjs <${Object.keys(WATCHES).join('|')}>`);
    process.exitCode = 64;
  } else {
    main({ key }).then(
      (code) => {
        process.exitCode = code;
      },
      (err) => {
        console.log(`   ci-headroom ${key} failed: ${brief(err)}`);
        process.exitCode = 3;
      },
    );
  }
}
