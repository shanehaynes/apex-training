#!/usr/bin/env node
// How close the `ios` CI job runs to its timeout-minutes cap.
//
// PR #503 set the cap to the slowest legitimate run seen (~57 min) plus 15.
// docs/ios/testing-and-ci.md says that once any run gets within 15 minutes of
// the cap, the fix is to shorten the job, not raise the cap again. The job's
// p50 grows 1–2 minutes a week as UI tests are added, so that day arrives on
// its own; this is what notices it.
//
// The cap is read out of origin/main's ci.yml rather than copied, so the
// report cannot drift from the workflow it watches. Every run of the last
// week is judged against main's cap today, not the one it ran under: after a
// raise, the old cap's kills fall below the line, which is what the raise was
// for.
//
// A run counts when its `Build and test` step was not skipped (a PR that
// changes no iOS path finishes the job in seconds) and its job took at least
// cap − 15 minutes. A run the cap killed ends `cancelled` at or past the cap,
// so it counts too. Every attempt of a re-run is looked at; the count is of
// runs.
//
// Prints its own lines in the report's style (ACTION at column 0, status
// indented). Exit codes follow scripts/signup-cap-check.mjs: 0 nothing near
// the cap; 1 an ACTION was printed; 2 could not check (gh missing or
// unauthenticated, API down). scripts/supervisor-report.sh runs it.

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = '.github/workflows/ci.yml';
const JOB = 'ios';
const STEP = 'Build and test';
export const HEADROOM_MIN = 15;
export const WINDOW_DAYS = 7;
const DAY_MS = 86400 * 1000;

/**
 * The ios job's cap and the name the jobs API reports it under, out of the
 * workflow's text. Throws when the shape this check depends on is gone.
 */
export function jobFrom(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^  ${JOB}:\\s*(#.*)?$`).test(l));
  if (start < 0) throw new Error(`no \`${JOB}\` job in ${WORKFLOW}`);
  // The job ends at the next line indented two spaces or less that is not a
  // comment: the next job, or the next top-level key.
  let end = lines.findIndex((l, i) => i > start && /^ {0,2}[^\s#]/.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end);

  // Job-level keys sit at four spaces; a step's own keys are deeper.
  const key = (k) => {
    const line = body.find((l) => l.startsWith(`    ${k}:`));
    return line === undefined ? undefined : scalar(line.slice(`    ${k}:`.length));
  };
  const timeout = key('timeout-minutes');
  if (timeout === undefined) throw new Error(`the \`${JOB}\` job in ${WORKFLOW} has no timeout-minutes`);
  if (!/^\d+$/.test(timeout)) throw new Error(`the \`${JOB}\` job's timeout-minutes is not a number (${timeout})`);
  if (!body.some((l) => /^\s+(- )?name:/.test(l) && scalar(l.replace(/^\s+(- )?name:/, '')) === STEP)) {
    throw new Error(`the \`${JOB}\` job in ${WORKFLOW} has no "${STEP}" step`);
  }
  // A job-level `name:` is what the jobs API reports instead of the key.
  const name = key('name') ?? JOB;
  if (name.includes('${{')) throw new Error(`the \`${JOB}\` job's name is an expression (${name})`);
  return { cap: Number(timeout), name };
}

/** A one-line YAML scalar: trailing comment and surrounding quotes dropped. */
function scalar(raw) {
  return raw.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
}

/** The jobs API names a matrix job `<name> (<values>)`. */
const isJob = (apiName, name) => apiName === name || apiName.startsWith(`${name} (`);

/**
 * Runs whose jobs are worth fetching. A completed run's job cannot have taken
 * longer than the run's own created→updated span (a re-run keeps the run's
 * createdAt), so a shorter run needs no API call. A run still going has no
 * such bound, so it is always fetched.
 */
export function candidates(runs, cap) {
  const floor = (cap - HEADROOM_MIN) * 60 * 1000;
  return runs
    .filter((r) => r.status !== 'completed' || Date.parse(r.updatedAt) - Date.parse(r.createdAt) >= floor)
    .map((r) => r.databaseId);
}

/** Built, finished attempts of the job that came within HEADROOM_MIN of the cap. */
export function nearCap(jobs, cap, name = JOB) {
  const floor = (cap - HEADROOM_MIN) * 60;
  return jobs
    .filter((j) => isJob(j.name, name) && j.status === 'completed' && j.started_at && j.completed_at)
    .filter((j) => (j.steps ?? []).some((s) => s.name === STEP && s.conclusion !== 'skipped'))
    .map((j) => ({
      run: j.run_id,
      attempt: j.run_attempt,
      conclusion: j.conclusion,
      seconds: (Date.parse(j.completed_at) - Date.parse(j.started_at)) / 1000,
    }))
    .filter((j) => j.seconds >= floor);
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

export async function main({ gh = ghCli, now = Date.now(), workflow } = {}) {
  let job;
  try {
    job = jobFrom(workflow ?? workflowText());
  } catch (err) {
    console.log(`ACTION ios CI headroom is unwatched: ${brief(err)} — update scripts/ios-ci-headroom.mjs to the workflow's shape`);
    return 1;
  }
  const { cap } = job;

  const since = new Date(now - WINDOW_DAYS * DAY_MS).toISOString().replace(/\.\d+Z$/, 'Z');
  let runs;
  try {
    runs = JSON.parse(await gh([
      'run', 'list', '--workflow', 'ci.yml', '--created', `>=${since}`, '--limit', '1000',
      '--json', 'databaseId,status,createdAt,updatedAt',
    ]));
  } catch (err) {
    console.log(`   could not list CI runs (${brief(err)}) — ios CI headroom skipped`);
    return 2;
  }

  const ids = candidates(runs, cap);
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
  const hits = nearCap(pages.filter(Boolean).flat(), cap, job.name);

  if (hits.length) {
    const slowest = hits.reduce((a, b) => (b.seconds > a.seconds ? b : a));
    // Runs, not attempts: re-running failed jobs copies the passed ones into
    // the new attempt with the same timestamps, so one slow job can appear
    // once per attempt.
    const runCount = new Set(hits.map((h) => h.run)).size;
    console.log(
      `ACTION ios CI: ${runCount} run(s) within ${HEADROOM_MIN} min of the ${cap}-minute cap ` +
        `(slowest ${Math.floor(slowest.seconds / 60)} min, run ${slowest.run}) — ` +
        'shorten the job rather than raise the cap (docs/ios/testing-and-ci.md)',
    );
  }
  if (unread) {
    console.log(`   ${unread} of ${ids.length} long CI run(s) could not be read — ios CI headroom partly skipped`);
  }
  if (hits.length) return 1;
  if (unread) return 2;
  console.log(`   no built ios run within ${HEADROOM_MIN} min of the ${cap}-minute cap in ${WINDOW_DAYS} days (${runs.length} CI runs)`);
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.log(`   ios-ci-headroom failed: ${brief(err)}`);
      process.exitCode = 3;
    },
  );
}
