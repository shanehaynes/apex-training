#!/usr/bin/env node
// Merge policy for scripts/merge-babysit.sh: which PRs may land without a
// human. The babysitter asks per PR; exit 0 means auto-mergeable, exit 10
// means hold for a human (reason on stdout).
//
// The held list is a blast-radius boundary, not a style call. Held:
//
//   - every path that defines the automation's own authority — this policy,
//     the babysitter, the guard hooks, .claude/settings.json, and each script
//     that settings file allow-lists. The agent must never be able to merge
//     an expansion of what the agent may do.
//   - .github/: required CI checks are the floor under every autonomous
//     merge, so changes to them need the human whose floor it is.
//   - supabase/migrations/: applied to production by hand — merging one
//     creates an obligation only a human can discharge.
//   - vercel.json: once blackholed every /api/ route (PR #25); CI cannot see
//     production routing.
//   - package.json / package-lock.json: a new dependency deserves a human
//     eye; npm audit only knows about published vulnerabilities.
//
// A human grants a per-PR exception with the `shipit` label — GitHub-side,
// auditable, revocable. A review approval cannot be the token: gh acts as
// the repo owner, who cannot approve their own PRs. The guard hooks block
// the agent from applying the label to its own PRs (see bash-guard.mjs).
//
// Unlike the guard hooks (fail open — a broken guard must not brick every
// session), this fails CLOSED: no verdict, no merge.

import { readFileSync } from 'node:fs';

// Entries ending in `/` hold everything under the directory; others hold the
// exact path. One rule per reason so the hold message says why, not just what.
export const HELD = [
  { path: '.claude/settings.json', reason: 'hook wiring and permission grants' },
  { path: 'scripts/hooks/', reason: 'the guard layer' },
  { path: 'scripts/merge-policy.mjs', reason: 'this policy' },
  { path: 'scripts/merge-policy.d.mts', reason: 'this policy' },
  { path: 'scripts/merge-babysit.sh', reason: 'the merge actor (allow-listed in settings)' },
  { path: 'scripts/deploy-verify.sh', reason: 'post-merge verification (allow-listed in settings)' },
  { path: 'scripts/git-tidy.sh', reason: 'removes worktrees (allow-listed in settings)' },
  { path: 'scripts/supervisor-report.sh', reason: 'allow-listed in settings' },
  { path: 'scripts/combine-check.sh', reason: 'allow-listed in settings' },
  { path: '.github/', reason: 'CI is the merge floor' },
  { path: 'supabase/migrations/', reason: 'applied to production by hand' },
  { path: 'vercel.json', reason: 'production routing (the /api/ blackhole, PR #25)' },
  { path: 'package.json', reason: 'dependency changes deserve a human eye' },
  { path: 'package-lock.json', reason: 'dependency changes deserve a human eye' },
];

export const GRANT_LABEL = 'shipit';

/**
 * The hold message for this change set, or null when it is auto-mergeable.
 * `changed` is the PR's total changed-file count: gh caps the file listing,
 * so a count mismatch means unseen paths — hold rather than guess.
 */
export function decide(paths, labels, changed = paths.length) {
  if (labels.includes(GRANT_LABEL)) return null;
  if (changed !== paths.length) {
    return `file list is truncated (${paths.length} of ${changed} seen) — cannot prove no held path changed`;
  }
  const held = [];
  for (const p of paths) {
    const rule = HELD.find((r) => (r.path.endsWith('/') ? p.startsWith(r.path) : p === r.path));
    if (rule) held.push(`${p} — ${rule.reason}`);
  }
  if (held.length === 0) return null;
  return `held for a human: ${held.join('; ')}`;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.stderr.write('merge-policy: unreadable stdin — holding (fail closed)\n');
    return 10;
  }
  const paths = input?.paths;
  const labels = input?.labels;
  if (
    !Array.isArray(paths) || !paths.every((p) => typeof p === 'string')
    || !Array.isArray(labels) || !labels.every((l) => typeof l === 'string')
  ) {
    process.stderr.write('merge-policy: expected {"paths": [...], "labels": [...]} on stdin — holding\n');
    return 10;
  }
  const changed = typeof input.changed === 'number' ? input.changed : paths.length;
  const verdict = decide(paths, labels, changed);
  if (verdict) {
    process.stdout.write(verdict + '\n');
    return 10;
  }
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  process.exit(main());
}
