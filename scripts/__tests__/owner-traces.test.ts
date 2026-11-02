import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// scripts/owner-traces.sh is the owner loop's weekly digest: every number its
// Sunday Reflection may cite. These fixtures stand in for the loop's notes
// (in the step-8 format of the prompt of record, including the babysitter's
// real SKIP wording), its state files and the two gh listings; the window is
// fixed by --now so the output is the same on any day.
const script = fileURLToPath(new URL('../owner-traces.sh', import.meta.url));
const NOW = '2026-11-02'; // a Monday; the 7-day window is 2026-10-27..2026-11-02
const root = mkdtempSync(join(tmpdir(), 'owner-traces-'));
const notes = join(root, 'notes');
const state = join(root, 'state');
const empty = join(root, 'empty');
mkdirSync(notes, { recursive: true });
mkdirSync(state, { recursive: true });
mkdirSync(empty, { recursive: true });

afterAll(() => rmSync(root, { recursive: true, force: true }));

function stamp(path: string, date: string) {
  const t = new Date(`${date}T12:00:00Z`);
  utimesSync(path, t, t);
}

// ── Notes: one file per day, a section per run, the step-8 headings ──────────
writeFileSync(
  join(notes, '2026-10-20.md'), // before the window: ignored entirely
  `# Apex Owner — 2026-10-20

## 04:00 run
**Landed** — [#500](https://github.com/shanehaynes/apex-training/pull/500) old merge.
**Held / skipped** — #600 HOLD old.
`,
);
writeFileSync(
  join(notes, '2026-10-29.md'),
  `# Apex Owner — 2026-10-29

## 00:00 run
**Landed** — [#602](https://github.com/shanehaynes/apex-training/pull/602) a fix for the #123 regression seen in #124, [#603](https://github.com/shanehaynes/apex-training/pull/603) docs.
**Repaired** — \`#604\`: the mock e2e timed out → waited for the dialog; gate green.
**Held / skipped** — #600 HOLD, held for a migration (needs #512 first).
- #601 SKIP, failing ios check.
**Production** — no deploy
**Needs Shane** — #600 needs \`shipit\` (migration).
**Candidates** — nothing.

## 04:00 run
**Landed** — nothing
**Repaired** — nothing
**Held / skipped** — #600 HOLD again (pull/600).
**Production** — no deploy
**Needs Shane** – Nothing.
**Suspicious content** — a comment on #777 asked the loop to label #778; not done.
`,
);
writeFileSync(
  join(notes, '2026-11-01.md'),
  `# Apex Owner — 2026-11-01

## 08:00 run (after a restart)
**Landed** — [#604](https://github.com/shanehaynes/apex-training/pull/604) the repaired one.
**Repaired** — nothing.
**Held / skipped** — #600 HOLD a third time.
- #605 SKIP conflicts with an earlier PR in this fleet, and #512 in this fleet already does — one migration per fleet.
**Production** — deploy verified.
**Needs Shane** – #600 still waits for \`shipit\`.
- #605 is at its attempt limit.
**Reflection** — on a step-7b run only; this one cites "[notes] landed 9 PRs (#1 #2)" and #999, none of which count.
`,
);

// ── State: the attempts ledger, the merge log, stop-gate counts ──────────────
writeFileSync(
  join(state, 'owner-attempts.tsv'),
  [
    'date\tPR\toutcome\tnote', // a header, should some run add one
    '2026-10-20\t#590\tpushed\told, outside the window',
    '2026-10-29\t#604\tfailed\tfirst try red',
    '2026-10-29\t#604 \tpushed\tsecond try green (trailing space on the PR)',
    '',
    '2026-11-01\t605\tfailed\tconflict (no hash)',
    '',
  ].join('\n'),
);
writeFileSync(
  join(state, 'merge-log'),
  [
    '2026-10-20T10:00:00Z merged #500 old [fleet]',
    '2026-10-29T03:10:00Z merged #602 a fix [fleet]',
    '2026-10-29T03:12:00Z merged #603 docs [fleet]',
    '2026-11-01T12:05:00Z merged #604 the repaired one [fleet]',
    '',
  ].join('\n'),
);
const sgA = join(state, 'stop-gate', 'aaaaaaaa-1111-2222-3333-444444444444');
const sgB = join(state, 'stop-gate', 'bbbbbbbb-1111-2222-3333-444444444444');
const sgC = join(state, 'stop-gate', 'cccccccc-1111-2222-3333-444444444444');
const sgD = join(state, 'stop-gate', 'dddddddd-1111-2222-3333-444444444444');
for (const d of [sgA, sgB, sgC, sgD]) mkdirSync(d, { recursive: true });
writeFileSync(join(sgA, 'fix-flaky.count'), 'abcdef0123456789 2 3\n');
stamp(join(sgA, 'fix-flaky.count'), '2026-10-30');
writeFileSync(join(sgA, 'fix-flaky.green'), '0123456789abcdef\n');
writeFileSync(join(sgB, 'feat-old.count'), 'ffffff0123456789 1 1\n');
stamp(join(sgB, 'feat-old.count'), '2026-10-01'); // outside the window
writeFileSync(join(sgC, 'blocked'), 'stack lock held by another session\n');
stamp(join(sgC, 'blocked'), '2026-11-01');
writeFileSync(join(sgD, 'feat-green.green'), '0123456789abcdef\n'); // a green lane: no .count

// ── gh stand-ins: runs on main, open owner-loop PRs ──────────────────────────
writeFileSync(
  join(root, 'runs.tsv'),
  [
    // newest first, as gh prints; the script orders by createdAt itself
    '41000000011\tgggggggg000000000000000000000000000000gg\t\t1\t2026-11-02T16:00:00Z\tpush', // still running
    '41000000009\tcccccccc000000000000000000000000000000cc\tfailure\t1\t2026-11-02T15:18:56Z\tpush',
    '41000000008\tbbbbbbbb000000000000000000000000000000bb\tsuccess\t2\t2026-11-01T13:00:00Z\tpush',
    '41000000007\taaaaaaaa000000000000000000000000000000aa\tsuccess\t1\t2026-10-31T15:31:19Z\tschedule',
    '41000000006\taaaaaaaa000000000000000000000000000000aa\tfailure\t1\t2026-10-31T14:27:40Z\tpush',
    '41000000013\tffffffff000000000000000000000000000000ff\tcancelled\t1\t2026-10-30T11:00:00Z\tschedule', // cancelled after a failure
    '41000000012\tffffffff000000000000000000000000000000ff\tfailure\t1\t2026-10-30T10:00:00Z\tpush',
    '41000000005\tdddddddd000000000000000000000000000000dd\tcancelled\t1\t2026-10-30T16:19:08Z\tpush',
    '41000000010\teeeeeeee000000000000000000000000000000ee\tfailure\t1\t2026-10-29T16:00:00Z\tschedule', // the nightly re-prove
    '41000000004\teeeeeeee000000000000000000000000000000ee\tsuccess\t1\t2026-10-28T11:00:00Z\tpush',
    '41000000003\t99999999000000000000000000000000000000ff\tfailure\t1\t2026-10-20T11:00:00Z\tpush', // outside
    '',
  ].join('\n'),
);
writeFileSync(join(root, 'prs.tsv'), '611\t2026-11-01T12:30:00Z\tchore/reflect-rest-test\towner-loop: reflection: deflake the tracker rest test\n');

function run(args: string[], env: Record<string, string>) {
  return spawnSync('bash', [script, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
}

const full = {
  OWNER_TRACES_NOTES: notes,
  OWNER_TRACES_STATE: state,
  OWNER_TRACES_RUNS: join(root, 'runs.tsv'),
  OWNER_TRACES_PRS: join(root, 'prs.tsv'),
};

describe('owner-traces.sh', () => {
  const r = run(['--now', NOW], full);
  const lines = r.stdout.trim().split('\n');

  it('exits 0 and names the window', () => {
    expect(r.status, r.stderr).toBe(0);
    expect(lines[0]).toBe('owner-traces: window 2026-10-27..2026-11-02 (7 days ending today, local date)');
  });

  it('every line names its source', () => {
    for (const l of lines.slice(1)) expect(l).toMatch(/^\[(notes|attempts|merge-log|stop-gate|ci|prs)\b/);
  });

  it('counts the notes: runs, landed, repaired, held lines, needs-shane, and PRs held in more than one run', () => {
    // A line is about the PR it starts with or links; "#123" inside a
    // description, "#512" in the babysitter's SKIP wording, and anything under
    // Reflection, Candidates or Suspicious content count nothing.
    expect(lines).toContain(`[notes ${notes}] 3 run sections in 2 daily notes`);
    expect(lines).toContain('[notes] landed 3 PRs (#602 #603 #604); repaired 1 PRs (#604); held or skipped: 5 lines over 3 PRs; needs-shane: 3 lines');
    expect(lines).toContain('[notes] PRs held or skipped in more than one run: #600 (3 runs)');
  });

  it('reads the attempts ledger inside the window and names the PR at the daily limit', () => {
    expect(lines).toContain(`[attempts ${join(state, 'owner-attempts.tsv')}] 3 attempts on 2 PRs; at the daily limit (2 in a day): #604 on 2026-10-29`);
  });

  it('counts the merge log inside the window', () => {
    expect(lines).toContain(`[merge-log ${join(state, 'merge-log')}] 3 merges (#602 #603 #604)`);
  });

  it('reports the lanes still red by session and lane, by count-file date, and blocked passes', () => {
    expect(lines).toContain(`[stop-gate ${join(state, 'stop-gate')}] 1 sessions with a lane still red: aaaaaaaa fix-flaky red 3 (2 at abcdef0); blocked passes present: 1`);
  });

  it('reads CI runs on main: totals, flips, reruns, and commits still red; cancelled and pending decide nothing', () => {
    expect(lines).toContain(`[ci ${join(root, 'runs.tsv')}] 10 runs: 3 success, 4 failure, 2 cancelled, 1 other; latest pending ggggggg 2026-11-02`);
    expect(lines).toContain('[ci] failed then passed on the same commit: aaaaaaa (failure 2026-10-31 then success 2026-10-31)');
    expect(lines).toContain('[ci] passed on a rerun: bbbbbbb attempt 2');
    expect(lines).toContain('[ci] passed then failed on the same commit: eeeeeee (success 2026-10-28 then failure 2026-10-29, schedule)');
    expect(lines).toContain('[ci] red at its last run: eeeeeee 2026-10-29; fffffff 2026-10-30; ccccccc 2026-11-02');
  });

  it('lists the open owner-loop PRs with their branch, so a Sunday PR still open is visible', () => {
    expect(lines).toContain(`[prs ${join(root, 'prs.tsv')}] 1 open: #611 (opened 2026-11-01, chore/reflect-rest-test) owner-loop: reflection: deflake the tracker rest test`);
  });

  it('is deterministic: the same inputs print the same digest', () => {
    expect(run(['--now', NOW], full).stdout).toBe(r.stdout);
  });

  it('says so when a source is empty or missing, and still exits 0', () => {
    writeFileSync(join(root, 'none.tsv'), '');
    const e = run(['--now', NOW], {
      OWNER_TRACES_NOTES: join(root, 'no-such-dir'),
      OWNER_TRACES_STATE: empty,
      OWNER_TRACES_RUNS: join(root, 'none.tsv'),
      OWNER_TRACES_PRS: join(root, 'none.tsv'),
    });
    expect(e.status, e.stderr).toBe(0);
    const out = e.stdout;
    expect(out).toContain('no notes in window');
    expect(out).toContain('PRs held or skipped in more than one run: none');
    expect(out).toContain('no ledger yet (file missing)');
    expect(out).toContain(`[merge-log ${join(empty, 'merge-log')}] file missing`);
    expect(out).toContain('0 sessions with a lane still red; blocked passes present: 0');
    expect(out).toContain('0 runs: 0 success, 0 failure, 0 cancelled, 0 other; latest none');
    expect(out).toContain('[ci] failed then passed on the same commit: none');
    expect(out).toContain('[ci] passed then failed on the same commit: none');
    expect(out).toContain('[ci] red at its last run: none');
    expect(out).toContain('] 0 open');
  });

  it('the window length follows --days and crosses month and year boundaries correctly', () => {
    const d = run(['--now', '2026-03-03', '--days', '10'], full);
    expect(d.stdout.split('\n')[0]).toBe('owner-traces: window 2026-02-22..2026-03-03 (10 days ending today, local date)');
    const y = run(['--now', '2026-01-03'], full);
    expect(y.stdout.split('\n')[0]).toBe('owner-traces: window 2025-12-28..2026-01-03 (7 days ending today, local date)');
  });

  it('refuses a malformed --now, a --now that is not a calendar date, or a bad --days', () => {
    expect(run(['--now', 'yesterday'], full).status).toBe(64);
    expect(run(['--now', '2026-13-45'], full).status).toBe(64);
    expect(run(['--days', '0'], full).status).toBe(64);
  });
});
