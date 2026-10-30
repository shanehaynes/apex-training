#!/usr/bin/env node
// Merge policy for scripts/merge-babysit.sh: which PRs may land without a
// human. The babysitter asks per PR; exit 0 means auto-mergeable, exit 10
// means hold for a human (reason on stdout).
//
// The held list is a blast-radius boundary, not a style call. Held:
//
//   - every path that defines the automation's own authority — this policy,
//     the babysitter, the guard hooks, .claude/settings.json, and every script
//     a permissions grant in that file would cover. The agent must never be
//     able to merge an expansion of what the agent may do. Exceptions below
//     are content checks on provability holds; none applies to this group.
//   - .github/ and scripts/ci-guards.sh: required CI checks are the floor
//     under every autonomous merge, and the guards script is where the
//     floor's content now lives (ci.yml delegates to it), so changes to
//     either need the human whose floor it is.
//   - the iOS release surface: ios/fastlane/ and ios/scripts/ are the lane
//     that ships a build, and ios/project.yml, ios/Config/, the
//     entitlements, the Info.plists and PrivacyInfo.xcprivacy decide what
//     Apple receives — none of it is provable by CI here.
//   - supabase/migrations/: applied to production by hand — merging one
//     creates an obligation only a human can discharge.
//   - vercel.json: once blackholed every /api/ route (PR #25); CI cannot see
//     production routing.
//   - package.json / package-lock.json: a new dependency deserves a human
//     eye; npm audit only knows about published vulnerabilities. The line is
//     a new NAME, not a new version: a name is a publisher nobody has chosen
//     yet, a bump is one already trusted. So a manifest change that only
//     moves versions of names already present, with every lockfile entry
//     fetched from the npm registry with an integrity hash and no package
//     newly gaining an install script, is not held (manifestHold below).
//     Anything else in the manifest — scripts, overrides, engines, a git or
//     file spec, a dev dependency promoted to runtime — still is.
//   - evals/baseline/: the promoted eval run that defines what correct coach
//     behavior IS. Every other held path is something CI cannot prove; this
//     one is the standard CI proves things against, which is the same
//     problem one level up. A PR that does not change behavior needs no
//     baseline edit and still auto-merges; one that deliberately changes it
//     has to refresh the baseline, and that is Shane's call, not the
//     agent's. (evals/gate/ is NOT held: the attestation is evidence, and it
//     is only valid while its hashes match the tree.)
//
// A human grants a per-PR exception with the `shipit` label — GitHub-side,
// auditable, revocable. A review approval cannot be the token: gh acts as
// the repo owner, who cannot approve their own PRs. The guard hooks block
// the agent from applying the label to its own PRs (see bash-guard.mjs).
//
// Unlike the guard hooks (fail open — a broken guard must not brick every
// session), this fails CLOSED: no verdict, no merge.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Entries ending in `/` hold everything under the directory; others hold the
// exact path. One rule per reason so the hold message says why, not just what.
export const HELD = [
  { path: '.claude/settings.json', reason: 'hook wiring and permission grants' },
  { path: 'scripts/hooks/', reason: 'the guard layer' },
  { path: '.claude/skills/parallel-agents/hooks/', reason: 'the guard layer (subagent launches)' },
  { path: 'scripts/merge-policy.mjs', reason: 'this policy' },
  { path: 'scripts/merge-policy.d.mts', reason: 'this policy' },
  { path: 'scripts/merge-babysit.sh', reason: 'the merge actor' },
  { path: 'scripts/deploy-verify.sh', reason: 'post-merge verification' },
  { path: 'scripts/git-tidy.sh', reason: 'removes worktrees' },
  { path: 'scripts/supervisor-report.sh', reason: 'the supervisor sweep' },
  { path: 'scripts/prod-schema-check.mjs', reason: 'run by supervisor-report.sh holding the production service-role key' },
  { path: 'scripts/combine-check.sh', reason: 'the cross-branch gate' },
  { path: 'scripts/owner-preflight.sh', reason: "the owner loop's kill switch and no-API rule" },
  { path: '.github/', reason: 'CI is the merge floor' },
  { path: 'scripts/ci-guards.sh', reason: "the merge floor's content" },
  { path: 'ios/fastlane/', reason: 'the release lane' },
  { path: 'ios/scripts/', reason: 'the release lane' },
  { path: 'ios/project.yml', reason: 'what Apple receives' },
  { path: 'ios/Config/', reason: 'what Apple receives' },
  { path: 'ios/Apex/Apex.entitlements', reason: 'what Apple receives' },
  { path: 'ios/Apex/Info.plist', reason: 'what Apple receives' },
  { path: 'ios/Apex/PrivacyInfo.xcprivacy', reason: 'what Apple receives' },
  { path: 'ios/ApexWidgets/Info.plist', reason: 'what Apple receives' },
  { path: 'supabase/migrations/', reason: 'applied to production by hand' },
  { path: 'vercel.json', reason: 'production routing (the /api/ blackhole, PR #25)' },
  { path: 'package.json', reason: 'dependency changes deserve a human eye' },
  { path: 'package-lock.json', reason: 'dependency changes deserve a human eye' },
  { path: 'evals/baseline/', reason: 'redefines what correct coach behavior is' },
  { path: 'MISSION.md', reason: 'the mission; only Shane amends it' },
  { path: 'CLAUDE.md', reason: 'loads the constitution into every session' },
  { path: 'TECHSTACK.md', reason: 'stack decisions loaded into every session' },
  { path: 'ROADMAP.md', reason: 'the roadmap; changes land through a replan Shane approves' },
  { path: '.claude/CLAUDE.md', reason: 'session instructions with the constitution\'s standing' },
  { path: 'CLAUDE.local.md', reason: 'session instructions with the constitution\'s standing' },
  { path: '.claude/rules/', reason: 'session instructions with the constitution\'s standing' },
];

// Files npm reads wherever they sit: a nested manifest, an .npmrc (which can
// point every registry URL at another host), a shrinkwrap (which npm ci
// prefers over package-lock.json), other package managers' lockfiles.
export const HELD_PATTERNS = [
  { re: /(^|\/)\.npmrc$/, reason: 'npm configuration (registry, scripts) — dependency changes deserve a human eye' },
  { re: /(^|\/)npm-shrinkwrap\.json$/, reason: 'npm ci prefers it over package-lock.json' },
  { re: /(^|\/)(?:yarn\.lock|\.yarnrc(?:\.yml)?|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb?)$/, reason: 'another package manager\'s manifest' },
  { re: /^.+\/package\.json$/, reason: 'a nested package manifest' },
];

export const GRANT_LABEL = 'shipit';

const SEMVER_RANGE = /^(?:[~^]|[<>]=?|=)?\s*v?\d+(?:\.(?:\d+|x|\*)){0,2}(?:-[0-9A-Za-z.-]+)?(?:\s*(?:\|\||-)?\s*(?:[~^]|[<>]=?|=)?\s*v?\d+(?:\.(?:\d+|x|\*)){0,2}(?:-[0-9A-Za-z.-]+)?)*$/;
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const REGISTRY = 'https://registry.npmjs.org/';

const parse = (text) => {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Why this package.json change needs a human, or null when it only moves versions of names already present. */
export function manifestHold(before, after) {
  if (before == null) return 'package.json is new';
  if (after == null) return 'package.json is deleted';
  const b = parse(before);
  const a = parse(after);
  if (!b || !a) return 'package.json does not parse';
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (!DEP_SECTIONS.includes(key) && !same(b[key], a[key])) return `package.json changes "${key}"`;
  }
  const where = (pkg, name) => DEP_SECTIONS.filter((s) => pkg[s] && Object.hasOwn(pkg[s], name));
  for (const section of DEP_SECTIONS) {
    for (const [name, spec] of Object.entries(a[section] ?? {})) {
      const was = where(b, name);
      if (was.length === 0) return `adds a new dependency: ${name}`;
      if (!was.includes(section) && section !== 'devDependencies') return `moves ${name} into ${section}`;
      if (typeof spec !== 'string' || !SEMVER_RANGE.test(spec.trim())) return `${name}@${spec} is not a registry semver range`;
    }
  }
  return null;
}

const LOCK_KEY = /^(?:node_modules\/(?:@[^/.][^/]*\/)?[^/.][^/]*\/)*node_modules\/(?:@[^/.][^/]*\/)?[^/.][^/]*$/;
const TARBALL = /^https:\/\/registry\.npmjs\.org\/((?:@[^/]+\/)?[^/]+)\/-\//;
const keyName = (path) => path.replace(/^.*node_modules\//, '');

/**
 * Why this package-lock.json needs a human, or null when every entry is the
 * registry tarball of the package its key installs, with an integrity hash,
 * and none newly runs an install script. The name check is what makes "the
 * registry" mean "this publisher": an entry's key is the name it installs as,
 * so a tarball of any other name is a swap (or an npm: alias, which is held
 * in package.json too unless the lockfile already had it).
 */
export function lockfileHold(before, after) {
  if (after == null) return 'package-lock.json is deleted';
  const a = parse(after);
  if (!a || !a.packages || typeof a.packages !== 'object') return 'package-lock.json does not parse';
  const b = before == null ? null : parse(before);
  if (before != null && !b) return 'package-lock.json (before) does not parse';
  const scripted = new Set();
  const aliases = new Set();
  for (const [path, entry] of Object.entries(b?.packages ?? {})) {
    if (entry?.hasInstallScript) scripted.add(`${keyName(path)}=${entry.name ?? keyName(path)}`);
    if (entry?.name && entry.name !== keyName(path)) aliases.add(`${keyName(path)}=${entry.name}`);
  }
  for (const [path, entry] of Object.entries(a.packages)) {
    if (path === '') continue;
    if (!entry || typeof entry !== 'object') return `package-lock.json entry ${path} is malformed`;
    if (!LOCK_KEY.test(path)) return `package-lock.json has an entry outside node_modules: ${path}`;
    if (entry.link) return `${path} is a link`;
    const name = keyName(path);
    const real = typeof entry.name === 'string' ? entry.name : name;
    if (real !== name && !aliases.has(`${name}=${real}`)) return `${path} is a new alias for ${real}`;
    if (entry.inBundle) {
      const parent = path.slice(0, path.lastIndexOf('/node_modules/'));
      const bundled = a.packages[parent]?.bundleDependencies ?? a.packages[parent]?.bundledDependencies;
      if (!parent || !Array.isArray(bundled) || !bundled.includes(name)) return `${path} claims to be bundled but its parent does not bundle it`;
      if (entry.resolved === undefined) continue;
    }
    const m = typeof entry.resolved === 'string' ? TARBALL.exec(entry.resolved) : null;
    if (!m) return `${path} resolves outside the npm registry (${entry.resolved ?? 'no resolved URL'})`;
    if (m[1] !== real) return `${path} resolves to a different package (${m[1]})`;
    if (entry.resolved !== `${REGISTRY}${real}/-/${real.split('/').pop()}-${entry.version}.tgz`) {
      return `${path} resolves to ${entry.resolved}, not ${real}@${entry.version}`;
    }
    if (typeof entry.integrity !== 'string' || !/^sha(?:256|384|512)-/.test(entry.integrity)) return `${path} has no integrity hash`;
    if (entry.hasInstallScript && !scripted.has(`${name}=${real}`)) return `${name} newly runs an install script`;
  }
  return null;
}

// A held path with a content check: the path is not held when `check`
// returns null for the PR's sources. Every check fails closed on missing
// sources. Authority-chain paths never get one.
const CONDITIONAL = {
  'package.json': (src) => {
    const m = src?.['package.json'];
    return m ? manifestHold(m.before, m.after) : 'package.json contents were not provided';
  },
  'package-lock.json': (src) => {
    const l = src?.['package-lock.json'];
    if (!l) return 'package-lock.json contents were not provided';
    return lockfileHold(l.before, l.after);
  },
};

/**
 * The hold message for this change set, or null when it is auto-mergeable.
 * `changed` is the PR's total changed-file count: gh caps the file listing,
 * so a count mismatch means unseen paths — hold rather than guess.
 * `sources` carries `{ before, after }` file contents (null for a side where
 * the file does not exist) for paths with a content check (CONDITIONAL).
 * `diffPaths` is git's own list of the change (diffPaths below): gh names
 * only a rename's new path, so `git mv vercel.json x.json` would otherwise
 * read as adding x.json, and a held exact path could leave by renaming.
 */
export function decide(paths, labels, changed = paths.length, sources = undefined, diffPaths = []) {
  if (labels.includes(GRANT_LABEL)) return null;
  if (changed !== paths.length) {
    return `file list is truncated (${paths.length} of ${changed} seen) — cannot prove no held path changed`;
  }
  const held = [];
  for (const p of new Set([...paths, ...diffPaths])) {
    const rule = HELD.find((r) => (r.path.endsWith('/') ? p.startsWith(r.path) : p === r.path))
      ?? HELD_PATTERNS.find((r) => r.re.test(p));
    if (!rule) continue;
    const check = Object.hasOwn(CONDITIONAL, p) ? CONDITIONAL[p] : null;
    const why = check ? check(sources) : null;
    if (check && why === null) continue;
    held.push(`${p} — ${rule.reason}${why ? ` (${why})` : ''}`);
  }
  if (held.length === 0) return null;
  return `held for a human: ${held.join('; ')}`;
}

/** A git runner when the PR's head commit is present locally (fetched from its pull ref if need be), else null. */
function fetchHead(number, head) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) return null;
  try {
    if (Number.isInteger(number)) git('fetch', '-q', 'origin', `refs/pull/${number}/head`);
  } catch {
    // The commit may already be here; the check below decides.
  }
  try {
    return git('rev-parse', '--verify', '-q', `${head}^{commit}`) === head ? git : null;
  } catch {
    return null;
  }
}

/**
 * Every path the PR changes, both sides of a rename, from git between its
 * merge base with origin/main and its head; null when git cannot say.
 */
export function diffPaths(number, head) {
  const git = fetchHead(number, head);
  if (!git) return null;
  try {
    git('fetch', '-q', 'origin', 'main');
    return git('diff', '--name-only', '--no-renames', '-z', `origin/main...${head}`).split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** `{ before, after }` for each conditional path, read at the merge base with origin/main and at the head; undefined when they cannot be read. */
export function gatherSources(paths, number, head) {
  const wanted = paths.filter((p) => Object.hasOwn(CONDITIONAL, p));
  if (wanted.length === 0) return undefined;
  const git = fetchHead(number, head);
  if (!git) return undefined;
  let base;
  try {
    git('fetch', '-q', 'origin', 'main');
    base = git('merge-base', 'origin/main', head);
  } catch {
    return undefined;
  }
  // null only when the file is absent at `rev`; a read that fails for any
  // other reason (maxBuffer, a git error) makes the whole read fail closed.
  const show = (rev, p) => {
    try {
      execFileSync('git', ['cat-file', '-e', `${rev}:${p}`], { stdio: 'ignore' });
    } catch {
      return null;
    }
    return execFileSync('git', ['show', `${rev}:${p}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  };
  const out = {};
  try {
    for (const p of wanted) out[p] = { before: show(base, p), after: show(head, p) };
  } catch {
    return undefined;
  }
  return out;
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
  let sources;
  let diff = [];
  if (!labels.includes(GRANT_LABEL)) {
    diff = diffPaths(input.number, input.head);
    if (diff === null) {
      process.stdout.write('could not list the change with git at the PR head — cannot see what a rename moved away from\n');
      return 10;
    }
    sources = gatherSources([...new Set([...paths, ...diff])], input.number, input.head);
  }
  const verdict = decide(paths, labels, changed, sources, diff);
  if (verdict) {
    process.stdout.write(verdict + '\n');
    return 10;
  }
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  process.exit(main());
}
