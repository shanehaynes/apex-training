#!/usr/bin/env node
// Diff PRODUCTION's database against the schema main's code expects.
//
//   node scripts/prod-schema-check.mjs              # expected schema: origin/main, fetched first
//   node scripts/prod-schema-check.mjs --ref <rev>  # any commit, no fetch
//
// WHY THIS EXISTS
// Production migrations are pasted into the Supabase SQL Editor by hand, and
// nothing noticed a skipped one. On 2026-09-15 prod was missing phase38
// (profiles.coach_model), phase41 (provider_connections.client) and the
// phase32_quarantine table, so GET /api/profile, the review-cron recipient
// listing, COROS connection reads and DELETE /api/account were all 500ing —
// while /api/version (scripts/deploy-verify.sh) showed current code. That
// proves the code, never the database.
//
// HOW
// src/lib/db/database.types.ts is generated from a database built from every
// migration, and CI fails when it drifts, so at origin/main it is the schema
// main's code runs against. For each public table (and view) it names:
//   GET /rest/v1/<table>?select=<every Row column>&limit=0
// 200 [] means every column exists; limit=0 means no row is ever read. On a
// failure, select=* tells a missing table (PGRST205) from a missing column,
// and the columns are then probed one at a time, because Postgres names only
// the first missing one (42703). Exposed functions are the /rpc/* paths of the
// OpenAPI document at GET /rest/v1/. Each missing object is printed with the
// migration that creates it.
//
// Credentials: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY — from the
// environment when both are set (that is how the nightly CI job passes the
// repository secrets; a runner has no .env.local), else from .env.local, this
// checkout's and then the primary checkout's. The key goes in request headers
// only and is never printed.
//
// Exit codes: 0 in sync; 1 drift; 2 could not check (no credentials, project
// unreachable or paused, key rejected) — an outage is not drift, so
// scripts/supervisor-report.sh prints 2 as status, never an ACTION; 3 the
// check itself failed (unreadable ref, a types file it cannot parse).
//
// Honest limits: PostgREST cannot see triggers, RLS policies, grants,
// constraints, defaults, column types, function signatures or realtime
// publication membership (phase40). A migration that only changes those can
// sit unapplied without this noticing.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES_PATH = 'src/lib/db/database.types.ts';
const MIGRATIONS_DIR = 'supabase/migrations/';
const BLIND_SPOTS =
  'triggers, RLS policies, grants, constraints, defaults, column types, function signatures, realtime publication membership (phase40)';
const USAGE = 'usage: node scripts/prod-schema-check.mjs [--ref <git-ref>]   (default: origin/main, fetched first)';

// ── the expected schema: database.types.ts ──────────────────────────────────
// Parsed rather than imported: this is plain node, the file is TypeScript, and
// it comes out of git, not the working tree. The walk tracks braces and
// strings rather than indentation, so a formatting change in the generator
// cannot quietly shrink the list — and a shape it does not recognise throws
// instead of reporting an empty schema as in sync.

/** If a string literal or comment starts at `i`, the index of its last character; else -1. */
function skipAt(src, i) {
  const c = src[i];
  if (c === '"' || c === "'" || c === '`') {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === c) return j;
    }
    return src.length - 1;
  }
  if (c === '/' && src[i + 1] === '/') {
    const nl = src.indexOf('\n', i);
    return nl < 0 ? src.length - 1 : nl - 1; // the newline itself still separates members
  }
  if (c === '/' && src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2);
    return end < 0 ? src.length - 1 : end + 1;
  }
  return -1;
}

/** The text between the first `{` in `text` and its matching `}`. */
function braceBody(text) {
  const open = text.indexOf('{');
  let depth = 0;
  for (let i = open; i >= 0 && i < text.length; i++) {
    const skip = skipAt(text, i);
    if (skip >= 0) i = skip;
    else if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error(`expected an object type at: ${text.trim().slice(0, 40)}`);
}

const KEY = /(?:([A-Za-z_$][\w$]*)|"((?:[^"\\]|\\.)*)")\??\s*:/y;

/** The members of an object type body, in order, each with its value's source text. */
function members(body) {
  const found = [];
  let depth = 0;
  let atMember = true;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    const skip = skipAt(body, i);
    if (skip >= 0 && c === '/') {
      i = skip; // a comment neither starts nor ends a member
      continue;
    }
    if (depth === 0 && atMember && !/\s/.test(c)) {
      atMember = false;
      KEY.lastIndex = i;
      const m = KEY.exec(body);
      if (m) {
        found.push({ name: m[1] ?? JSON.parse(`"${m[2]}"`), keyAt: i, valueAt: KEY.lastIndex });
        i = KEY.lastIndex - 1;
        continue;
      }
    }
    if (skip >= 0) i = skip;
    else if ('{[('.includes(c)) depth++;
    else if ('}])'.includes(c)) depth--;
    else if (depth === 0 && (c === '\n' || c === ';' || c === ',')) atMember = true;
  }
  return found.map((f, k) => ({
    name: f.name,
    value: body.slice(f.valueAt, found[k + 1]?.keyAt ?? body.length).trim(),
  }));
}

/** The public schema's tables and views, each with its Row columns, and its function names. */
export function parseDatabaseTypes(src) {
  const at = src.search(/export\s+type\s+Database\s*=\s*\{/);
  if (at < 0) throw new Error('no `export type Database = {` — has the generator output changed shape?');
  const pick = (list, name, where) => {
    const found = list.find((m) => m.name === name);
    if (!found) throw new Error(`no ${name} in ${where} — has the generator output changed shape?`);
    return members(braceBody(found.value));
  };
  const schema = pick(members(braceBody(src.slice(at))), 'public', 'Database');
  const relations = (section) =>
    pick(schema, section, 'public').map(({ name, value }) => ({
      name,
      columns: pick(members(braceBody(value)), 'Row', `public.${section}.${name}`).map((c) => c.name),
    }));
  const tables = relations('Tables');
  if (tables.length === 0) throw new Error('public.Tables is empty — refusing to call an empty schema in sync');
  return { tables, views: relations('Views'), functions: pick(schema, 'Functions', 'public').map((f) => f.name) };
}

// ── where each object comes from: supabase/migrations ───────────────────────

/** SQL split into statements, comments dropped; a `;` inside quotes or a $$ body does not split. */
function statements(sql) {
  const out = [];
  let cur = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = (nl < 0 ? sql.length : nl) - 1;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 1;
      cur += ' ';
      continue;
    }
    let close = -1;
    if (c === "'" || c === '"') {
      close = i + 1;
      while (close < sql.length && !(sql[close] === c && sql[close + 1] !== c)) close += sql[close] === c ? 2 : 1;
    } else if (c === '$') {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        close = end < 0 ? sql.length : end + tag.length - 1;
      }
    }
    if (close >= 0) {
      cur += sql.slice(i, close + 1);
      i = close;
    } else if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** `text` split on commas outside parentheses and quotes. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, i + 1);
      i = close < 0 ? text.length : close;
    } else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  parts.push(text.slice(from).trim());
  return parts.filter(Boolean);
}

/** The text inside the parenthesis that opens at `open`. */
function parenBody(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, i + 1);
      i = close < 0 ? text.length : close;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

const IDENT = String.raw`"(?:[^"]|"")+"|[A-Za-z_][\w$]*`;
const NAME = String.raw`(?:(${IDENT})\s*\.\s*)?(${IDENT})`; // [schema.]name
const CREATE_TABLE = new RegExp(
  String.raw`^create\s+(?:(?:global|local)\s+)?(?:(?:temp|temporary|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?${NAME}\s*(\()?`,
  'i',
);
const CREATE_VIEW = new RegExp(
  String.raw`^create\s+(?:or\s+replace\s+)?(?:(?:temp|temporary)\s+)?(?:recursive\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?${NAME}`,
  'i',
);
const CREATE_FUNCTION = new RegExp(String.raw`^create\s+(?:or\s+replace\s+)?function\s+${NAME}\s*\(`, 'i');
const ALTER_TABLE = new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${NAME}\s+`, 'i');
const ADD_COLUMN = new RegExp(String.raw`^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?(${IDENT})`, 'i');
const RENAME_COLUMN = new RegExp(String.raw`^rename\s+(?:column\s+)?(${IDENT})\s+to\s+(${IDENT})`, 'i');
const RENAME_TABLE = new RegExp(String.raw`^rename\s+to\s+(${IDENT})`, 'i');
const LEADING_IDENT = new RegExp(`^(${IDENT})`);
const NOT_A_COLUMN = /^(?:constraint|primary|unique|check|foreign|exclude|like)$/i;
// A column added through dynamic SQL (phase9's EXECUTE format('ALTER TABLE %I
// ADD COLUMN …')) names no table this can read, so it is only a lead.
const LOOSE_ADD_COLUMN = new RegExp(String.raw`\badd\s+column\s+(?:if\s+not\s+exists\s+)?(${IDENT})`, 'gi');

const unquote = (id) => (id.startsWith('"') ? id.slice(1, -1).replaceAll('""', '"') : id.toLowerCase());
/** The object's name when it lives in public (or names no schema), else null. */
const publicName = (schema, name) => (!schema || unquote(schema) === 'public' ? unquote(name) : null);

/**
 * Which migration creates each public table, view, column and function.
 * `files` must be in apply order (sort -V); every lookup lists the files that
 * create the object, first creator first.
 */
export function migrationIndex(files) {
  const index = { relations: new Map(), columns: new Map(), functions: new Map(), loose: new Map() };
  const note = (map, key, entry) => map.set(key, [...(map.get(key) ?? []), entry]);
  for (const { file, sql } of files) {
    const stmts = statements(sql);
    for (const stmt of stmts) {
      let m;
      if ((m = CREATE_TABLE.exec(stmt))) {
        const table = publicName(m[1], m[2]);
        if (!table) continue;
        note(index.relations, table, { file });
        if (!m[3]) continue;
        for (const item of splitTopLevel(parenBody(stmt, m[0].length - 1))) {
          const column = LEADING_IDENT.exec(item)?.[1];
          if (column && !NOT_A_COLUMN.test(column)) note(index.columns, `${table}.${unquote(column)}`, { file, inCreate: true });
        }
      } else if ((m = CREATE_VIEW.exec(stmt))) {
        const view = publicName(m[1], m[2]);
        if (view) note(index.relations, view, { file });
      } else if ((m = CREATE_FUNCTION.exec(stmt))) {
        const fn = publicName(m[1], m[2]);
        if (fn) note(index.functions, fn, { file });
      } else if ((m = ALTER_TABLE.exec(stmt))) {
        const table = publicName(m[1], m[2]);
        if (!table) continue;
        for (const action of splitTopLevel(stmt.slice(m[0].length))) {
          const add = ADD_COLUMN.exec(action);
          const renamedTable = RENAME_TABLE.exec(action);
          const renamedColumn = RENAME_COLUMN.exec(action);
          if (add && !NOT_A_COLUMN.test(add[1])) note(index.columns, `${table}.${unquote(add[1])}`, { file });
          else if (renamedTable) note(index.relations, unquote(renamedTable[1]), { file });
          else if (renamedColumn) note(index.columns, `${table}.${unquote(renamedColumn[2])}`, { file });
        }
      }
    }
    for (const m of stmts.join(';\n').matchAll(LOOSE_ADD_COLUMN)) note(index.loose, unquote(m[1]), { file });
  }
  return index;
}

/** Where a missing object comes from, as a phrase for the report. */
export function sourceOf(missing, index) {
  if (missing.kind === 'function') {
    const files = (index.functions.get(missing.name) ?? []).map((d) => d.file);
    if (files.length === 0) return 'no file in supabase/migrations defines it';
    return files.length === 1 ? `defined in ${files[0]}` : `defined in ${files.join(', ')} — the last is current`;
  }
  if (missing.kind !== 'column') {
    const [first] = index.relations.get(missing.name) ?? [];
    return first ? `created by ${first.file}` : 'no file in supabase/migrations creates it';
  }
  const entries = index.columns.get(`${missing.table}.${missing.name}`) ?? [];
  const alter = entries.find((e) => !e.inCreate);
  if (alter) return `added by ${alter.file}`;
  if (entries.length > 0) {
    return `in ${entries[0].file}'s CREATE TABLE, which IF NOT EXISTS skips for an existing table — it needs an ALTER TABLE … ADD COLUMN`;
  }
  const [lead] = index.loose.get(missing.name) ?? [];
  return lead
    ? `no migration adds it to ${missing.table} by name; ${lead.file} adds a ${missing.name} column through dynamic SQL`
    : 'no file in supabase/migrations adds it';
}

// ── probing production ──────────────────────────────────────────────────────

const TABLE_MISSING = new Set(['PGRST205', '42P01']); // 42P01: PostgREST before the schema-cache error
const COLUMN_MISSING = '42703';

/** A select-list entry: bare when PostgREST takes it bare, quoted otherwise. */
const selectable = (column) => (/^[a-z_][a-z0-9_]*$/.test(column) ? column : `"${column.replaceAll('"', '""')}"`);
const explain = (result) => [result.status, result.code, result.message].filter(Boolean).join(' ');
const reason = (err) => err.cause?.code ?? err.cause?.message ?? err.message;

/**
 * Probe a project for every table, view, column and function in `expected`.
 * Resolves { skipped } when it cannot be checked at all, else
 * { missing, unverified } — both empty means in sync.
 */
export async function checkSchema({ url, key, expected, fetch = globalThis.fetch, concurrency = 6 }) {
  const headers = { apikey: key, ...(key.startsWith('sb_') ? {} : { Authorization: `Bearer ${key}` }) };
  const request = (path) => fetch(`${url}/rest/v1/${path}`, { headers, signal: AbortSignal.timeout(15_000) });
  const host = new URL(url).host;

  // The OpenAPI document first: it proves the project answers and the key
  // works before anything is called missing, and it lists the functions.
  let openapi;
  try {
    openapi = await request('');
  } catch (err) {
    return { skipped: `could not reach ${host} (${reason(err)})` };
  }
  if (openapi.status === 401 || openapi.status === 403) {
    return { skipped: `${host} rejected the service-role key (${openapi.status}) — rotated in the dashboard but not in .env.local?` };
  }
  if (openapi.status >= 500) return { skipped: `${host} answered ${openapi.status} — paused or down` };

  const missing = [];
  const unverified = [];
  const paths = openapi.ok ? (await openapi.json().catch(() => null))?.paths : null;
  if (paths) {
    const exposed = new Set(Object.keys(paths).filter((p) => p.startsWith('/rpc/')).map((p) => p.slice('/rpc/'.length)));
    for (const name of expected.functions) if (!exposed.has(name)) missing.push({ kind: 'function', name });
  } else if (expected.functions.length > 0) {
    unverified.push({ what: 'functions', why: `GET /rest/v1/ answered ${openapi.status} with no OpenAPI paths` });
  }

  const probe = async (relation, select) => {
    const res = await request(`${encodeURIComponent(relation)}?select=${encodeURIComponent(select)}&limit=0`);
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, status: res.status, code: body.code, message: body.message };
  };

  const checkRelation = async ({ kind, name, columns }) => {
    const all = await probe(name, columns.length > 0 ? columns.map(selectable).join(',') : '*');
    if (all.ok) return;
    const star = await probe(name, '*');
    if (TABLE_MISSING.has(star.code)) {
      missing.push({ kind, name });
      return;
    }
    if (!star.ok) {
      unverified.push({ what: name, why: explain(star) });
      return;
    }
    // The relation is there, so a column is not — and Postgres names only the
    // first one missing, so each column gets its own probe.
    let found = 0;
    for (const column of columns) {
      const one = await probe(name, selectable(column));
      if (one.ok) continue;
      found++;
      if (one.code === COLUMN_MISSING) missing.push({ kind: 'column', table: name, name: column });
      else unverified.push({ what: `${name}.${column}`, why: explain(one) });
    }
    if (found === 0) unverified.push({ what: name, why: `every column answers alone but not together: ${explain(all)}` });
  };

  const queue = [
    ...expected.tables.map((t) => ({ kind: 'table', ...t })),
    ...expected.views.map((v) => ({ kind: 'view', ...v })),
  ];
  const worker = async () => {
    while (queue.length > 0) {
      const relation = queue.shift();
      try {
        await checkRelation(relation);
      } catch (err) {
        unverified.push({ what: relation.name, why: reason(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  const rank = (m) => `${['table', 'view', 'column', 'function'].indexOf(m.kind)} ${m.table ?? ''}.${m.name}`;
  missing.sort((a, b) => rank(a).localeCompare(rank(b)));
  unverified.sort((a, b) => a.what.localeCompare(b.what));
  return { missing, unverified };
}

// ── the command ─────────────────────────────────────────────────────────────

// Unattended sweeps run this: a fetch must fail, not hang on a credential prompt.
function git(...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

/** Every migration at `ref`, in apply order (sort -V). */
function migrationsAt(ref) {
  return git('ls-tree', '--name-only', ref, MIGRATIONS_DIR)
    .split('\n')
    .filter((path) => path.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((path) => ({ file: path.slice(MIGRATIONS_DIR.length), sql: git('show', `${ref}:${path}`) }));
}

// The environment first — a CI runner has secrets and no .env.local, and an
// explicit export is also how you aim this at a project other than the one
// .env.local describes. Then the same resolution as scripts/check-models.mjs:
// this checkout's .env.local, then the primary checkout's — .env.local is
// gitignored, so a fresh worktree has none of its own and falls through via
// its .git file. Both halves are required together: a URL from one source and
// a key from the other would probe one project with another's credentials.
function credentials() {
  const envUrl = process.env.VITE_SUPABASE_URL?.trim();
  const envKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (envUrl && envKey) return { url: envUrl.replace(/\/+$/, ''), key: envKey };

  const dirs = [root];
  try {
    const gitdir = readFileSync(join(root, '.git'), 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    if (gitdir) dirs.push(resolve(root, gitdir[1], '..', '..', '..'));
  } catch { /* .git is a directory (primary checkout) or absent */ }
  for (const dir of dirs) {
    let raw;
    try {
      raw = readFileSync(join(dir, '.env.local'), 'utf8');
    } catch {
      continue;
    }
    const get = (name) => raw.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1].trim().replace(/^(["'])(.*)\1$/, '$2');
    const url = get('VITE_SUPABASE_URL');
    const key = get('SUPABASE_SERVICE_ROLE_KEY');
    if (url && key) return { url: url.replace(/\/+$/, ''), key };
  }
  return null;
}

async function main(argv) {
  let ref = 'origin/main';
  let fetchRef = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ref' && argv[i + 1]) {
      ref = argv[++i];
      fetchRef = false;
    } else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log(USAGE);
      return 0;
    } else {
      console.error(USAGE);
      return 64;
    }
  }

  const creds = credentials();
  if (!creds) {
    console.log('no VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment or .env.local — production schema check skipped');
    return 2;
  }
  if (fetchRef) {
    try {
      git('fetch', '--quiet', 'origin', 'main');
    } catch {
      console.log('(fetch failed — comparing against the last known origin/main)');
    }
  }
  let expected;
  let sha;
  try {
    sha = git('rev-parse', '--short', `${ref}^{commit}`).trim();
    expected = parseDatabaseTypes(git('show', `${ref}:${TYPES_PATH}`));
  } catch (err) {
    console.log(`could not read the expected schema at ${ref}: ${err.stderr?.trim() || err.message}`);
    return 3;
  }

  const relations = [...expected.tables, ...expected.views];
  const scope =
    `${expected.tables.length} tables${expected.views.length > 0 ? `, ${expected.views.length} views` : ''}` +
    ` (${relations.reduce((n, r) => n + r.columns.length, 0)} columns) and ${expected.functions.length} functions`;
  console.log(`${new URL(creds.url).host} against ${TYPES_PATH} at ${ref} (${sha})`);

  const result = await checkSchema({ url: creds.url, key: creds.key, expected });
  if (result.skipped) {
    console.log(`${result.skipped} — check skipped`);
    return 2;
  }
  const { missing, unverified } = result;
  if (missing.length > 0) {
    let index = null;
    try {
      index = migrationIndex(migrationsAt(ref));
    } catch { /* the objects still get named, just without their migrations */ }
    for (const m of missing) {
      const what = m.kind === 'column' ? `column ${m.table}.${m.name}` : `${m.kind} ${m.name}`;
      console.log(`✗ ${what} is missing${index ? ` — ${sourceOf(m, index)}` : ''}`);
    }
  }
  for (const u of unverified) console.log(`? ${u.what} could not be checked: ${u.why}`);
  if (missing.length > 0) {
    console.log(
      `${missing.length} missing of the ${scope} main's code expects. Apply the statements that create them in the ` +
        'Supabase SQL Editor — read each migration first: one can also rewrite data, so a partly applied file wants ' +
        'only its missing statements, not a re-run.',
    );
  } else if (unverified.length > 0) {
    console.log(`nothing else of the ${scope} main's code expects is missing`);
  } else {
    console.log(`✓ all ${scope} main's code expects are present`);
  }
  console.log(`not visible to this check: ${BLIND_SPOTS}`);
  return missing.length > 0 ? 1 : unverified.length > 0 ? 2 : 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.log(`prod-schema-check failed: ${err.message}`);
      process.exitCode = 3;
    },
  );
}
