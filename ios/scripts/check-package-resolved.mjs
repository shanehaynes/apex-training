#!/usr/bin/env node
// Prove the committed ios/Package.resolved still describes the dependency graph
// the manifests declare.
//
//   node ios/scripts/check-package-resolved.mjs          list what is pinned
//   node ios/scripts/check-package-resolved.mjs --check  fail on disagreement (ci-guards.sh)
//
// WHY THIS EXISTS
// ios/Package.resolved is the transitive half of the pin: direct versions are
// exact in ios/project.yml (swift-snapshot-testing) and in
// ios/Packages/ApexKit/Package.swift (supabase-swift, GRDB), everything below
// them is whatever resolution chose. ios/scripts/sync-package-resolved.sh
// installs the committed file into the generated workspace before any build, so
// a stale file is worse than none: it would quietly hold a build to versions
// nobody asked for. Nothing on a Linux runner can re-resolve the graph to
// compare — there is no SwiftPM here and the packages are iOS-only — but the
// direct versions ARE checkable, and they are exactly the ones a human edits.
// A manifest bump whose Package.resolved was never refreshed is the drift this
// catches.
//
// Absent, the file is reported and passes: only a Mac can write the first one.
//
// Deliberately dependency-free — ci-guards.sh runs in --no-install worktrees.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESOLVED = join(ROOT, 'ios/Package.resolved');
const PROJECT_YML = join(ROOT, 'ios/project.yml');
const APEXKIT = join(ROOT, 'ios/Packages/ApexKit/Package.swift');

const check = process.argv.includes('--check');

const fail = (msg) => {
  console.error(`::error::${msg}`);
  process.exit(1);
};

// github.com/Foo/Bar.git, github.com/foo/bar/ and https://github.com/Foo/Bar
// are one dependency. Compare them the way SwiftPM's identity does: host and
// path, lowercased, without the .git suffix.
function normalize(url) {
  return String(url)
    .trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^/@]+@/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// The `packages:` block of the XcodeGen spec, which is the only place the app
// target's own remote dependencies are declared. Matched textually rather than
// with a YAML parser: this script has no dependencies, and the block is two
// keys deep.
function declaredInProjectYml() {
  const yml = readFileSync(PROJECT_YML, 'utf8');
  const block = yml.match(/^packages:\n((?:[ \t].*\n|\n)*)/m);
  if (!block) return [];
  const out = [];
  let url = null;
  for (const line of block[1].split('\n')) {
    if (/^ {2}\S/.test(line)) url = null; // a new package entry
    const seenUrl = line.match(/^\s+url:\s*(\S+)\s*$/);
    if (seenUrl) url = seenUrl[1].replace(/^["']|["']$/g, '');
    const seenVersion = line.match(/^\s+exactVersion:\s*["']?([^"'\s]+)["']?\s*$/);
    if (seenVersion && url) out.push({ url, version: seenVersion[1], source: 'ios/project.yml' });
  }
  return out;
}

// `.package(url: "…", exact: "…")` in ApexKit's manifest. Local `path:`
// packages have no resolved entry and are deliberately not matched.
function declaredInApexKit() {
  const swift = readFileSync(APEXKIT, 'utf8');
  const out = [];
  const re = /\.package\(\s*url:\s*"([^"]+)"\s*,\s*exact:\s*"([^"]+)"\s*\)/g;
  for (const m of swift.matchAll(re)) {
    out.push({ url: m[1], version: m[2], source: 'ios/Packages/ApexKit/Package.swift' });
  }
  return out;
}

// Package.resolved has had three shapes. v1 nests the pins under `object` and
// spells the url `repositoryURL`; v2 and v3 are flat with `location`.
function readPins() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(RESOLVED, 'utf8'));
  } catch (err) {
    fail(`ios/Package.resolved is not valid JSON (${err.message}). Regenerate it with ios/scripts/sync-package-resolved.sh --update on a Mac.`);
  }
  const raw = parsed?.pins ?? parsed?.object?.pins;
  if (!Array.isArray(raw)) {
    fail('ios/Package.resolved has no pins array — it is not a SwiftPM resolution file.');
  }
  return raw.map((pin) => ({
    identity: pin.identity ?? pin.package ?? '?',
    url: pin.location ?? pin.repositoryURL ?? '',
    version: pin.state?.version ?? null,
    revision: pin.state?.revision ?? null,
  }));
}

const declared = [...declaredInProjectYml(), ...declaredInApexKit()];
if (declared.length === 0) {
  fail('no exact-pinned remote packages found in ios/project.yml or ApexKit/Package.swift — this check would prove nothing. Did the manifests change shape?');
}

if (!existsSync(RESOLVED)) {
  // The workflows and scripts all tolerate its absence, so this does too — it
  // would otherwise make every CI run red until a Mac session lands the file.
  console.log(
    'ios/Package.resolved: not committed yet — transitive versions still float. ' +
      'On a Mac: xcodegen generate && xcodebuild -resolvePackageDependencies ' +
      '-project Apex.xcodeproj -scheme Apex && ios/scripts/sync-package-resolved.sh --update',
  );
  process.exit(0);
}

const pins = readPins();
const byUrl = new Map(pins.map((pin) => [normalize(pin.url), pin]));

const problems = [];
for (const dep of declared) {
  const pin = byUrl.get(normalize(dep.url));
  if (!pin) {
    problems.push(`${dep.url} is pinned to ${dep.version} in ${dep.source} but has no entry in ios/Package.resolved`);
  } else if (pin.version !== dep.version) {
    problems.push(
      `${dep.url}: ${dep.source} says ${dep.version}, ios/Package.resolved says ${pin.version ?? `(no version, revision ${pin.revision})`}`,
    );
  } else {
    console.log(`  ${pin.identity} ${pin.version} (exact, from ${dep.source})`);
  }
}

const transitive = pins.filter((pin) => !declared.some((dep) => normalize(dep.url) === normalize(pin.url)));
for (const pin of transitive) {
  console.log(`  ${pin.identity} ${pin.version ?? pin.revision} (transitive)`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  const msg =
    `ios/Package.resolved disagrees with the manifests on ${problems.length} dependenc${problems.length === 1 ? 'y' : 'ies'} (listed above). ` +
    'A version bumped in a manifest needs the resolution refreshed on a Mac: ' +
    'xcodegen generate && xcodebuild -resolvePackageDependencies -project Apex.xcodeproj -scheme Apex && ios/scripts/sync-package-resolved.sh --update';
  if (check) fail(msg);
  console.error(msg);
  process.exit(1);
}

console.log(`Package.resolved: ${declared.length} exact direct pins match, ${transitive.length} transitive pinned (ok)`);
