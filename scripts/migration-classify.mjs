// Is this migration additive — safe for the babysitter to apply to
// production without a human — and if so, what undoes it?
//
// "Additive" is a fail-closed allow-list, not a deny-list: every statement
// must match one of the shapes below or the file is held. The test for a
// shape is two questions. Can it lose or rewrite data that already exists?
// Can it widen who sees data that already exists? Both must be no, and the
// change must have a mechanical inverse, because the revert story for code
// (git revert) does not reach the database.
//
// Allowed:
//   create table <public name> (…)          — must also enable RLS in this file
//   alter table <t> add column …            — several per statement are fine
//   alter table <t> add constraint <n> …    — a restriction; it fails atomically
//                                             on existing rows that violate it
//   alter table <t> drop constraint if exists <n>, then add constraint <n>
//     check (…) on the same table later in the file — the replace-a-CHECK
//     pattern. It loses no data; the applier reads the old definition from
//     pg_constraint before applying, so the inverse can restore it
//   alter table <new t> enable row level security
//   create [unique] index <name> on <t> …   — not concurrently (one transaction)
//   comment on …
//   [drop policy if exists] / create policy / grant / revoke
//                                           — only on tables this file creates;
//                                             grants only to authenticated or
//                                             service_role. On an existing table
//                                             `using (true)` is purely additive
//                                             and exposes every row.
//   notify pgrst, 'reload schema'
//   the ledger stamp, last, matching this file's fingerprint
//
// A foreign key with an ON DELETE/UPDATE action other than NO ACTION or
// RESTRICT is held on an existing table: a cascade added there deletes
// existing rows later, when something else is deleted.
//
// Everything else is held: do blocks, functions, views, triggers, update,
// insert, drop (including drop-then-add constraint pairs, whose inverse
// would need the old definition), alter column, rename, alter policy,
// extensions, transaction control, other schemas.

import { fingerprint, parseStamp, statements } from './prod-schema-check.mjs';

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[a-z_][\w$]*)`;
const QNAME = String.raw`(?:${IDENT}\s*\.\s*)?${IDENT}`;

/** Lowercased, unquoted name in public; null for any other schema. */
function publicName(qname) {
  const parts = [];
  const re = new RegExp(IDENT, 'gi');
  let m;
  while ((m = re.exec(qname))) parts.push(m[0].startsWith('"') ? m[0].slice(1, -1).replaceAll('""', '"') : m[0].toLowerCase());
  if (parts.length === 1) return parts[0];
  if (parts.length === 2 && parts[0] === 'public') return parts[1];
  return null;
}

/** Index of the paren matching the one at `open`, skipping quotes; -1 if unbalanced. */
function closeParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, i + 1);
      if (close < 0) return -1;
      i = close;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
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

/** Text with string literals blanked, so keyword tests never match inside one. */
const unliteral = (text) => text.replace(/'(?:[^']|'')*'/g, "''").replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, "''");

const DESTRUCTIVE_FK = /\bon\s+(?:delete|update)\s+(?:cascade|set\s+null|set\s+default)\b/i;

const RE = {
  createTable: new RegExp(String.raw`^create\s+table\s+(?:if\s+not\s+exists\s+)?(${QNAME})\s*\(`, 'i'),
  alterTable: new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${QNAME})\s+([\s\S]+)$`, 'i'),
  addColumn: new RegExp(String.raw`^add\s+column\s+(?:if\s+not\s+exists\s+)?(${IDENT})\s+\S`, 'i'),
  addConstraint: new RegExp(String.raw`^add\s+constraint\s+(${IDENT})\s+(check|foreign\s+key|unique)\b`, 'i'),
  dropConstraint: new RegExp(String.raw`^drop\s+constraint\s+if\s+exists\s+(${IDENT})$`, 'i'),
  enableRls: /^enable\s+row\s+level\s+security$/i,
  createIndex: new RegExp(
    String.raw`^create\s+(?:unique\s+)?index\s+(?!concurrently\b)(?:if\s+not\s+exists\s+)?(${IDENT})\s+on\s+(?:only\s+)?(${QNAME})\s*(?:using\s+\w+\s*)?\(`,
    'i',
  ),
  comment: /^comment\s+on\s+/i,
  dropPolicy: new RegExp(String.raw`^drop\s+policy\s+if\s+exists\s+(?:${IDENT})\s+on\s+(${QNAME})$`, 'i'),
  createPolicy: new RegExp(String.raw`^create\s+policy\s+(?:${IDENT})\s+on\s+(${QNAME})\b`, 'i'),
  grant: new RegExp(String.raw`^grant\s+([\w\s,]+?)\s+on\s+(?:table\s+)?(${QNAME}(?:\s*,\s*${QNAME})*)\s+to\s+([\w\s,]+)$`, 'i'),
  revoke: new RegExp(String.raw`^revoke\s+([\w\s,]+?)\s+on\s+(?:table\s+)?(${QNAME}(?:\s*,\s*${QNAME})*)\s+from\s+([\w\s,]+)$`, 'i'),
  notify: /^notify\s+pgrst\s*,\s*'reload (?:schema|config)'$/i,
};

const GRANT_ROLES = new Set(['authenticated', 'service_role']);

/**
 * `{ additive: true, creates, inverse }` or `{ additive: false, reasons }`.
 * `file` is the migration's basename (phaseN_x.sql); `sql` its contents.
 * `creates` names what the apply must find absent first: `if not exists`
 * makes a statement a no-op when the object is already there, and the
 * inverse would then drop something this migration did not create.
 */
export function classify(file, sql) {
  const reasons = [];
  let stmts;
  try {
    stmts = statements(sql.replace(/^﻿/, '').replace(/\r\n?/g, '\n'));
  } catch (e) {
    return { additive: false, reasons: [`could not split into statements: ${e.message}`] };
  }
  const short = (st) => st.replace(/\s+/g, ' ').slice(0, 80);

  const last = stmts.at(-1);
  const stamp = last ? parseStamp(last) : null;
  if (!stamp) reasons.push('does not end with its ledger stamp');
  else {
    if (stamp.name !== file.replace(/\.sql$/, '')) reasons.push(`stamp names ${stamp.name}, not ${file}`);
    if (stamp.fingerprint !== fingerprint(sql)) reasons.push('stamp fingerprint does not match the file');
    stmts = stmts.slice(0, -1);
  }

  // First pass: which tables this file creates (access control may touch only these).
  const newTables = new Set();
  for (const st of stmts) {
    const m = RE.createTable.exec(st.trim());
    if (m) {
      const name = publicName(m[1]);
      if (name) newTables.add(name);
    }
  }

  const creates = { tables: [], columns: [], indexes: [], constraints: [], replacedChecks: [] };
  const dropped = new Map(); // "table.constraint" -> waiting for its re-add
  const rls = new Set();
  const isNew = (q) => {
    const n = publicName(q);
    return n !== null && newTables.has(n);
  };

  for (const raw of stmts) {
    const st = raw.trim();
    let m;
    if (parseStamp(st)) {
      reasons.push('a ledger stamp before the last statement');
    } else if ((m = RE.createTable.exec(st))) {
      const name = publicName(m[1]);
      const open = st.indexOf('(', m[0].length - 1);
      const close = closeParen(st, open);
      if (!name) reasons.push(`creates a table outside public: ${short(st)}`);
      else if (close < 0) reasons.push(`unbalanced create table: ${short(st)}`);
      else if (st.slice(close + 1).trim() !== '') reasons.push(`create table ${name} has clauses after its columns`);
      else if (splitTopLevel(st.slice(open + 1, close)).some((part) => /^like\b/i.test(part))) reasons.push(`create table ${name} uses LIKE`);
      else creates.tables.push(name);
    } else if ((m = RE.alterTable.exec(st))) {
      const table = publicName(m[1]);
      if (!table) {
        reasons.push(`alters a table outside public: ${short(st)}`);
        continue;
      }
      const fresh = newTables.has(table);
      for (const action of splitTopLevel(m[2])) {
        let a;
        const actionBare = unliteral(action);
        if ((a = RE.addColumn.exec(action))) {
          if (!fresh && DESTRUCTIVE_FK.test(actionBare)) reasons.push(`adds a cascading foreign key to existing table ${table}`);
          else if (!fresh) creates.columns.push({ table, column: publicName(a[1]) });
        } else if ((a = RE.dropConstraint.exec(action))) {
          dropped.set(`${table}.${publicName(a[1])}`, { table, name: publicName(a[1]) });
        } else if ((a = RE.addConstraint.exec(action))) {
          const name = publicName(a[1]);
          const key = `${table}.${name}`;
          if (dropped.has(key)) {
            dropped.delete(key);
            if (!/^check$/i.test(a[2])) reasons.push(`replaces constraint ${name} on ${table} with a non-CHECK constraint`);
            else if (!fresh) creates.replacedChecks.push({ table, name });
          } else if (!fresh && DESTRUCTIVE_FK.test(actionBare)) reasons.push(`adds a cascading foreign key to existing table ${table}`);
          else if (!fresh) creates.constraints.push({ table, name });
        } else if (RE.enableRls.test(action)) {
          if (fresh) rls.add(table);
          else reasons.push(`changes RLS on existing table ${table}`);
        } else {
          reasons.push(`alter table ${table}: ${short(action)}`);
        }
      }
    } else if ((m = RE.createIndex.exec(st))) {
      const table = publicName(m[2]);
      if (!table) reasons.push(`indexes a table outside public: ${short(st)}`);
      else if (!newTables.has(table)) creates.indexes.push(publicName(m[1]));
    } else if (RE.comment.test(st)) {
      // Metadata only.
    } else if ((m = RE.dropPolicy.exec(st))) {
      if (!isNew(m[1])) reasons.push(`drops a policy on existing table ${publicName(m[1]) ?? m[1]}`);
    } else if ((m = RE.createPolicy.exec(st))) {
      if (!isNew(m[1])) reasons.push(`creates a policy on existing table ${publicName(m[1]) ?? m[1]}`);
    } else if ((m = RE.grant.exec(st))) {
      const tables = m[2].split(',').map((t) => t.trim());
      const roles = m[3].split(',').map((r) => r.trim().toLowerCase());
      const old = tables.filter((t) => !isNew(t));
      if (old.length) reasons.push(`grants on existing table(s) ${old.join(', ')}`);
      const bad = roles.filter((r) => !GRANT_ROLES.has(r));
      if (bad.length) reasons.push(`grants to ${bad.join(', ')}`);
      if (/\bwith\s+grant\s+option\b/i.test(st)) reasons.push('grants with grant option');
    } else if ((m = RE.revoke.exec(st))) {
      const old = m[2].split(',').map((t) => t.trim()).filter((t) => !isNew(t));
      if (old.length) reasons.push(`revokes on existing table(s) ${old.join(', ')}`);
    } else if (RE.notify.test(st)) {
      // PostgREST cache reload.
    } else {
      reasons.push(`not an additive statement: ${short(st)}`);
    }
  }

  for (const t of creates.tables) if (!rls.has(t)) reasons.push(`creates table ${t} without enabling row level security`);
  for (const { table, name } of dropped.values()) reasons.push(`drops constraint ${name} on ${table} without re-adding it`);
  if (reasons.length) return { additive: false, reasons };

  const name = file.replace(/\.sql$/, '');
  const q = (id) => (/^[a-z_][a-z0-9_$]*$/.test(id) ? id : `"${id.replaceAll('"', '""')}"`);
  const inverse = [
    `-- Inverse of ${file}. Drops what it created, and anything written to it since.`,
    ...creates.indexes.map((i) => `drop index if exists public.${q(i)};`),
    ...creates.constraints.map((c) => `alter table public.${q(c.table)} drop constraint if exists ${q(c.name)};`),
    ...creates.replacedChecks.flatMap((c) => [
      `alter table public.${q(c.table)} drop constraint if exists ${q(c.name)};`,
      `-- restore ${c.name}: ${'{'}previous:${c.table}.${c.name}${'}'}`,
    ]),
    ...creates.columns.map((c) => `alter table public.${q(c.table)} drop column if exists ${q(c.column)};`),
    ...[...creates.tables].reverse().map((t) => `drop table if exists public.${q(t)};`),
    `delete from public.migration_ledger where name = '${name}';`,
    `notify pgrst, 'reload schema';`,
  ].join('\n');
  return { additive: true, creates, inverse };
}
