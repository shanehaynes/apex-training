#!/usr/bin/env node
// Diff the coach model catalog against Anthropic's live model list.
//
//   node scripts/check-models.mjs
//
// src/lib/coach/models.ts is hand-maintained, and nothing about it fails
// loudly when it goes stale: a retired id just falls back to the default, and
// a newly released model simply never appears in the picker. Neither shows up
// in CI, a test, or a user report — the catalog would quietly rot. This is the
// thing that notices.
//
// Read-only and ALWAYS exits 0: it is wired into supervisor-report.sh, which
// is a status sweep, not a gate. A missing key or an unreachable API is a
// skipped check, never a failure.
//
// What it CANNOT tell you: pricing. GET /v1/models returns no $/MTok, so the
// numbers in the catalog stay hand-maintained — check them against
// https://www.anthropic.com/pricing when you add or move an entry.

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Same resolution order as the eval runner (evals/src/models.ts): the shell
// wins, then .env.local, then the primary checkout's copy — .env.local is
// gitignored, so a fresh worktree has none of its own and falls through via
// its .git file.
function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const read = dir => {
    try {
      return readFileSync(join(dir, '.env.local'), 'utf8').match(/^ANTHROPIC_API_KEY=(\S+)\s*$/m)?.[1];
    } catch { return undefined; }
  };
  const own = read(root);
  if (own) return own;
  try {
    const gitdir = readFileSync(join(root, '.git'), 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    if (gitdir) return read(resolve(root, gitdir[1], '..', '..', '..'));
  } catch { /* .git is a directory (primary checkout) or absent */ }
  return undefined;
}

// Parsed out of the source rather than imported: this file is plain node with
// no build step, and models.ts is TypeScript. The catalog is a flat literal,
// so a regex over the id fields is enough — and if the shape ever changes
// this reports zero ids rather than silently passing.
function catalogIds() {
  const src = readFileSync(join(root, 'src/lib/coach/models.ts'), 'utf8');
  const ids = [...src.matchAll(/^\s{4}id: '([^']+)',$/gm)].map(m => m[1]);
  const fallback = src.match(/DEFAULT_COACH_MODEL = '([^']+)'/)?.[1];
  // Reviewed-and-declined ids, so a model we have already decided against
  // does not raise the same ACTION on every run until it is ignored.
  const declined = src.match(/DECLINED_MODELS[^{]*\{([\s\S]*?)^\};/m)?.[1] ?? '';
  const declinedIds = [...declined.matchAll(/^\s{2}'([^']+)':/gm)].map(m => m[1]);
  return { ids, fallback, declinedIds };
}

async function liveModels(key) {
  const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  });
  if (!res.ok) throw new Error(`GET /v1/models → ${res.status} ${await res.text().catch(() => '')}`.trim());
  const body = await res.json();
  return (body.data ?? []).map(m => ({ id: m.id, created: m.created_at ?? '' }));
}

const { ids, fallback, declinedIds } = catalogIds();

if (ids.length === 0) {
  console.log('ACTION could not parse any model ids out of src/lib/coach/models.ts — the catalog shape changed; update scripts/check-models.mjs');
  process.exit(0);
}
if (fallback && !ids.includes(fallback)) {
  console.log(`ACTION DEFAULT_COACH_MODEL "${fallback}" is not in COACH_MODELS — defaultCoachModel() throws`);
}

const key = apiKey();
if (!key) {
  console.log(`   catalog: ${ids.join(', ')}`);
  console.log('   no ANTHROPIC_API_KEY — live model check skipped');
  process.exit(0);
}

let live;
try {
  live = await liveModels(key);
} catch (err) {
  // An outage is not drift.
  console.log(`   could not reach the Models API — check skipped (${err.message})`);
  process.exit(0);
}

const liveIds = new Set(live.map(m => m.id));
const retired = ids.filter(id => !liveIds.has(id));
// Only models NEWER than everything we already carry are worth surfacing;
// the full list includes every legacy id back to Claude 2 and would drown
// the report in noise.
const newestKnown = live.filter(m => ids.includes(m.id)).map(m => m.created).sort().at(-1) ?? '';
const additions = live.filter(m =>
  !ids.includes(m.id) && !declinedIds.includes(m.id) && m.created > newestKnown);

console.log(`   catalog: ${ids.join(', ')}`);

if (retired.length > 0) {
  console.log(`ACTION coach catalog lists ${retired.length} model(s) the API no longer returns: ${retired.join(', ')} — drop them from src/lib/coach/models.ts (users on one already fall back to ${fallback})`);
}
if (additions.length > 0) {
  console.log(`ACTION ${additions.length} model(s) released since the newest catalog entry: ${additions.map(m => m.id).join(', ')} — consider adding to src/lib/coach/models.ts (pricing is not in the API; check the pricing page)`);
}
if (declinedIds.length > 0) {
  console.log(`   declined (reviewed, deliberately not offered): ${declinedIds.join(', ')}`);
}
if (retired.length === 0 && additions.length === 0) {
  console.log('   catalog current: every entry live, nothing newer released or unreviewed');
}
