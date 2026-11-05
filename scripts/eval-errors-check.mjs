#!/usr/bin/env node
// Fails the nightly `evals` CI job when a case measured nothing.
//
// `npm run eval` exits 0 whatever its cases did: a case whose model or judge
// call throws is recorded with an `error` and no verdicts, and the run still
// succeeds. So when the API key's credit ran out, every case answered
// `400 ... credit balance is too low` and the job went green in seconds, 23
// nights between 2026-09-15 and 10-28. A revoked key's 401, or a 429 that
// outlives the SDK's retries, looks the same. This reads the file
// `npm run eval -- --out <path>` wrote and turns that into a red job.
//
// One errored case is enough. The nightly is the API-backed measurement of
// record, and an errored case is one it did not make. A key that runs dry
// mid-run errors only the tail of the suite: six green nights did that, one
// with 2 of 38 cases errored (09-14) and one with 10 of 38 (09-08), so
// "every case errored" or "most" would have stayed green on them. Over 68
// nightlies (08-29..11-04) 1,428 cases errored and every one was a credit-out;
// no night had a stray transient error, so a bar of one costs no false reds
// on that record. If transient errors appear, the answer is a retry in the
// runner, as the gate's re-run is (evals/gate.ts), not a looser bar here.
//
// A `fail` verdict is not an error. It is a measurement, and the nightly stays
// advisory about verdicts: only `error` turns the job red. The runner keeps
// exiting 0 on errors because evals/gate.ts re-runs errored cases from the
// result file, and a non-zero exit would end the gate before that re-run.
//
// Exit codes: 0 every case was measured; 1 a case errored or the file holds
// no cases (one ::error:: annotation names the count and the first message);
// 2 the file is missing or unreadable. CI fails the step on either non-zero.

import { readFileSync } from 'node:fs';

const MAX_MESSAGE = 300;

/** Workflow-command data escaping: a raw newline would end the annotation. */
export function escapeData(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

const clip = (text) => (text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text);

/**
 * The verdict on one result file's parsed contents: what to print and the
 * exit code. Pure, so a test needs no file.
 */
export function judge(run) {
  if (!run || !Array.isArray(run.cases)) {
    return { code: 2, lines: ['::error title=Coach evals unreadable::the result file has no cases array.'] };
  }
  const total = run.cases.length;
  if (total === 0) {
    return { code: 1, lines: ['::error title=Coach evals measured nothing::the result file holds no cases.'] };
  }
  // `error` is set only when the case threw (evals/run.ts), and an empty
  // message is still an error.
  const errored = run.cases.filter((c) => c?.error != null);
  if (errored.length === 0) {
    return { code: 0, lines: [`coach evals: all ${total} case(s) measured, none errored.`] };
  }

  const first = errored[0];
  const measured = total - errored.length;
  const summary =
    `${errored.length} of ${total} coach eval case(s) errored, so the run measured ` +
    `${measured === 0 ? 'nothing' : `only ${measured}`}. First (${first.id}): ${clip(String(first.error))}`;

  // The distinct messages, most common first, so a log shows at a glance
  // whether one cause took the whole run down or several things broke.
  const counts = new Map();
  for (const c of errored) {
    const msg = clip(String(c.error));
    counts.set(msg, (counts.get(msg) ?? 0) + 1);
  }
  const distinct = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  return {
    code: 1,
    lines: [
      `::error title=Coach evals errored::${escapeData(summary)}`,
      `${distinct.length} distinct error message(s):`,
      ...distinct.map(([msg, n]) => `  ${n}x ${msg.replace(/\s+/g, ' ')}`),
      'errored cases:',
      ...errored.map((c) => `  ${c.id}`),
    ],
  };
}

export function main({ path, log = console.log, read = (p) => readFileSync(p, 'utf8') } = {}) {
  if (!path) {
    log('::error title=Coach evals unreadable::usage: eval-errors-check.mjs <result.json>');
    return 2;
  }
  let run;
  try {
    run = JSON.parse(read(path));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    log(`::error title=Coach evals unreadable::${escapeData(`could not read ${path}: ${clip(why)}`)}`);
    return 2;
  }
  const { code, lines } = judge(run);
  for (const line of lines) log(line);
  return code;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  process.exitCode = main({ path: process.argv[2] });
}
