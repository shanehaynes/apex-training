#!/usr/bin/env node
// Apply additive migrations to production — the babysitter's step between
// "production lacks only this PR's own migrations" and the merge.
//
//   node scripts/migration-apply.mjs --ref <sha> phase60_x.sql [phase61_y.sql …]
//
// Each file is read at <sha>, classified (scripts/migration-classify.mjs) and
// refused unless additive; then every object it creates is looked up in
// production and the run is refused if one already exists, because
// `if not exists` would make that statement a no-op and the inverse would
// drop something this migration never created. Files apply in phase order,
// one request each through the Supabase Management API
// (POST /v1/projects/<ref>/database/query). A query string of several
// statements runs as one implicit transaction, so a file applies entirely or
// not at all; no explicit BEGIN, which on a pooled connection could leave an
// aborted transaction behind.
//
// The access token is SUPABASE_ACCESS_TOKEN in ~/.config/apex-training/prod.env,
// next to the URL the schema check uses — nowhere else (not the environment,
// not .env.local), so the token's presence in that one file is the opt-in.
// The inverse SQL of every applied file is printed and kept under
// .claude/state/migration-inverses/ in the primary checkout.
//
// Exit: 0 applied all; 3 no token (nothing changed — apply by hand);
// 4 refused (not additive, an object already exists; nothing changed);
// 2 could not check or apply (an outage or a refusal); 1 a file failed to
// apply (the files before it applied — named on stdout).

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from './migration-classify.mjs';
import { PROD_ENV_FILE, credentials } from './prod-schema-check.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.supabase.com';

/** `{ url, projectRef, token }` from prod.env, `{ missing }` without a token, `{ error }` when unusable. */
export function applyCredentials({ prodEnvFile = PROD_ENV_FILE, checkCreds = credentials() } = {}) {
  let raw;
  try {
    raw = readFileSync(prodEnvFile, 'utf8');
  } catch {
    return { missing: `${prodEnvFile} not found` };
  }
  const get = (name) => raw.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1].trim().replace(/^(["'])(.*)\1$/, '$2');
  const token = get('SUPABASE_ACCESS_TOKEN');
  if (!token) return { missing: `no SUPABASE_ACCESS_TOKEN in ${prodEnvFile}` };
  const url = get('VITE_SUPABASE_URL')?.replace(/\/+$/, '');
  const projectRef = url && /^https:\/\/([a-z0-9]{20})\.supabase\.co$/.exec(url)?.[1];
  if (!projectRef) return { error: `VITE_SUPABASE_URL in ${prodEnvFile} is not https://<ref>.supabase.co` };
  // The schema check that proved production current must have looked at this same project.
  if (!checkCreds || checkCreds.url !== url) {
    return { error: `the schema check reads ${checkCreds?.url ?? 'no project'}, not ${url} — refusing to apply to a project it did not check` };
  }
  return { url, projectRef, token };
}

const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;

/** One SQL request; resolves rows or throws with `.kind` 'refused' | 'outage' | 'sql'. */
async function query({ projectRef, token, fetch }, sql) {
  let res;
  try {
    res = await fetch(`${API}/v1/projects/${projectRef}/database/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    });
  } catch (e) {
    throw Object.assign(new Error(`Management API unreachable: ${e.message}`), { kind: 'outage' });
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`Management API refused the token (${res.status})`), { kind: 'refused' });
  if (res.status >= 500) throw Object.assign(new Error(`Management API ${res.status}: ${text.slice(0, 300)}`), { kind: 'outage' });
  if (!res.ok) throw Object.assign(new Error(body?.message ?? text.slice(0, 300)), { kind: 'sql' });
  return Array.isArray(body) ? body : [];
}

/** SQL returning one row per object of `creates` that already exists in production. */
export function existenceSql(creates) {
  const probes = [
    ...creates.tables.map((t) => `select 'table ' || ${lit(t)} as found where to_regclass(${lit(`public."${t}"`)}) is not null`),
    ...creates.indexes.map((i) => `select 'index ' || ${lit(i)} as found where to_regclass(${lit(`public."${i}"`)}) is not null`),
    ...creates.columns.map(
      (c) => `select 'column ' || ${lit(`${c.table}.${c.column}`)} as found where exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = ${lit(c.table)} and column_name = ${lit(c.column)})`,
    ),
    ...creates.constraints.map(
      (c) => `select 'constraint ' || ${lit(`${c.table}.${c.name}`)} as found where exists (select 1 from pg_constraint where conname = ${lit(c.name)} and conrelid = to_regclass(${lit(`public."${c.table}"`)}))`,
    ),
  ];
  return probes.length ? probes.join('\nunion all\n') : null;
}

/** SQL returning { tbl, name, def } for each CHECK the migration replaces. */
export function previousChecksSql(replaced) {
  if (replaced.length === 0) return null;
  return replaced
    .map(
      (c) => `select ${lit(c.table)} as tbl, ${lit(c.name)} as name, pg_get_constraintdef(oid) as def from pg_constraint where conname = ${lit(c.name)} and conrelid = to_regclass(${lit(`public."${c.table}"`)})`,
    )
    .join('\nunion all\n');
}

/** The inverse with each replaced CHECK's placeholder filled from production's current definition. */
export function fillInverse(inverse, previous) {
  return inverse.replace(/^-- restore (.+): \{previous:([^.}]+)\.([^}]+)\}$/gm, (_line, _n, table, name) => {
    const row = previous.find((p) => p.tbl === table && p.name === name);
    const q = (id) => (/^[a-z_][a-z0-9_$]*$/.test(id) ? id : `"${id.replaceAll('"', '""')}"`);
    return row
      ? `alter table public.${q(table)} add constraint ${q(name)} ${row.def};`
      : `-- ${name} did not exist before this migration; nothing to restore`;
  });
}

/**
 * Classify, probe and apply `files` (each `{ file, sql }`, in apply order).
 * `log` receives each line of output. Resolves the exit code.
 */
export async function applyMigrations({ files, creds, fetch = globalThis.fetch, log = console.log, saveInverse = () => {} }) {
  const api = { ...creds, fetch };
  const plans = [];
  for (const { file, sql } of files) {
    const v = classify(file, sql);
    if (!v.additive) {
      log(`REFUSE ${file} — not additive:`);
      for (const r of v.reasons) log(`  - ${r}`);
      return 4;
    }
    plans.push({ file, sql, ...v });
  }
  try {
    for (const p of plans) {
      const probe = existenceSql(p.creates);
      const found = probe ? await query(api, probe) : [];
      if (found.length) {
        log(`REFUSE ${p.file} — already in production, so its inverse would drop something it did not create: ${found.map((r) => r.found).join(', ')}`);
        return 4;
      }
      const prev = previousChecksSql(p.creates.replacedChecks);
      p.inverse = fillInverse(p.inverse, prev ? await query(api, prev) : []);
    }
  } catch (e) {
    log(`could not probe production: ${e.message}`);
    return 2;
  }
  const done = [];
  for (const p of plans) {
    try {
      await query(api, p.sql);
    } catch (e) {
      log(`FAILED ${p.file} — ${e.message}${done.length ? ` (already applied: ${done.join(', ')})` : ' (nothing applied)'}`);
      return e.kind === 'sql' ? 1 : 2;
    }
    done.push(p.file);
    saveInverse(p.file, p.inverse);
    log(`APPLIED ${p.file}`);
    log('  inverse (run it to undo):');
    for (const line of p.inverse.split('\n')) log(`    ${line}`);
  }
  return 0;
}

function primaryCheckout() {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
    return resolve(root, common, '..');
  } catch {
    return root;
  }
}

async function main(argv) {
  const at = argv.indexOf('--ref');
  const ref = at >= 0 ? argv[at + 1] : null;
  const names = argv.filter((a, i) => a !== '--ref' && i !== at + 1);
  if (!ref || names.length === 0 || names.some((n) => !/^phase\d+_[\w-]+\.sql$/.test(n))) {
    console.error('usage: node scripts/migration-apply.mjs --ref <sha> phaseN_name.sql [...]');
    return 64;
  }
  const creds = applyCredentials();
  if (creds.missing) {
    console.log(`${creds.missing} — not applying; apply by hand in the Supabase SQL Editor`);
    return 3;
  }
  if (creds.error) {
    console.log(creds.error);
    return 2;
  }
  let files;
  try {
    files = names
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .map((file) => ({ file, sql: execFileSync('git', ['show', `${ref}:supabase/migrations/${file}`], { cwd: root, encoding: 'utf8' }) }));
  } catch (e) {
    console.log(`could not read the migrations at ${ref}: ${e.message}`);
    return 2;
  }
  const dir = join(primaryCheckout(), '.claude', 'state', 'migration-inverses');
  return applyMigrations({
    files,
    creds,
    saveInverse: (file, inverse) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file.replace(/\.sql$/, '.inverse.sql')), `${inverse}\n`);
    },
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  process.exit(await main(process.argv.slice(2)));
}
