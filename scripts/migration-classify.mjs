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
//
// On an existing table, DEFAULT, CHECK, generated and index expressions may
// call only a short list of side-effect-free built-ins (SAFE_CALLS): Postgres
// evaluates them over every existing row as the statement runs. And the file
// must lex the same way in Postgres as in statements() (lexicalHold).
//   comment on table|column|index <an object this file creates> is '…'
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
 * Why this file's text could split differently in Postgres than in
 * statements(), or null. Postgres lets `$` sit inside an identifier (a$q$ is
 * one name) and nests block comments; the splitter does neither. No allowed
 * shape needs a `$` or an escape string, so any `$` outside a plain string
 * literal, any E'' string and any nested comment holds the file.
 */
export function lexicalHold(sql) {
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const body = sql.slice(i + 2, end < 0 ? sql.length : end);
      if (end < 0) return 'an unterminated block comment';
      if (body.includes('/*')) return 'a nested block comment';
      i = end + 1;
    } else if (c === "'") {
      if (/[eE]/.test(sql[i - 1] ?? '') && !/[\w$]/.test(sql[i - 2] ?? '')) return "an E'' escape string";
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      if (j >= sql.length) return 'an unterminated string literal';
      i = j;
    } else if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      if (end < 0) return 'an unterminated quoted identifier';
      if (sql.slice(i + 1, end).includes('$')) return 'a $ in an identifier';
      i = end;
    } else if (c === '$') {
      return 'a $ outside a string literal (dollar quotes and $ in identifiers split differently in Postgres)';
    }
  }
  return null;
}

// Functions an expression on an existing table may call. A CHECK runs on every
// existing row when added, a DEFAULT once per existing row, an index
// expression on every row: anything else could write, read across rows, or
// copy server-side values into rows users can already read.
const SAFE_CALLS = new Set([
  'now', 'gen_random_uuid', 'coalesce', 'nullif', 'greatest', 'least', 'lower', 'upper', 'length', 'char_length',
  'octet_length', 'btrim', 'trim', 'jsonb_typeof', 'json_typeof', 'jsonb_array_length', 'array_length', 'cardinality',
]);
// Words followed by `(` that are syntax or type modifiers, not calls.
const NOT_CALLS = new Set([
  'check', 'in', 'key', 'unique', 'primary', 'foreign', 'using', 'include', 'where', 'and', 'or', 'not', 'is', 'as',
  'default', 'stored', 'array', 'varchar', 'char', 'character', 'varying', 'numeric', 'decimal', 'timestamp',
  'timestamptz', 'time', 'timetz', 'interval', 'bit', 'varbit', 'float', 'with', 'zone', 'any', 'all', 'collate', 'references',
]);

/** The first function call in `expr` that is not on the safe list, or null. */
function unsafeCall(expr) {
  const bare = unliteral(expr).replace(/\breferences\s+(?:"(?:[^"]|"")+"|[a-z_][\w]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[a-z_][\w]*))?\s*\(/gi, 'references (');
  if (/"\s*\(/.test(bare)) return 'a quoted name called as a function';
  if (/\(\s*select\b/i.test(bare) || /\bselect\b/i.test(bare)) return 'a subquery';
  for (const m of bare.matchAll(/([a-z_][\w]*)\s*(\.\s*[a-z_][\w]*\s*)?\(/gi)) {
    if (m[2]) return `${m[1]}${m[2].replace(/\s+/g, '')}()`;
    const name = m[1].toLowerCase();
    if (!SAFE_CALLS.has(name) && !NOT_CALLS.has(name)) return `${name}()`;
  }
  return null;
}

/**
 * `{ additive: true, creates, inverse }` or `{ additive: false, reasons }`.
 * `file` is the migration's basename (phaseN_x.sql); `sql` its contents.
 * `creates` names what the apply must find absent first: `if not exists`
 * makes a statement a no-op when the object is already there, and the
 * inverse would then drop something this migration did not create.
 */
export function classify(file, sql) {
  const reasons = [];
  const lexical = lexicalHold(sql);
  if (lexical) return { additive: false, reasons: [`cannot be split safely: ${lexical}`] };
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

  const creates = { tables: [], columns: [], indexes: [], constraints: [], replacedChecks: [], newColumns: [] };
  const dropped = new Map(); // "table.constraint" -> waiting for its re-add
  const newIndexes = new Set();
  const comments = [];
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
        const call = !fresh && (RE.addColumn.test(action) || RE.addConstraint.test(action)) ? unsafeCall(action) : null;
        if (call) {
          reasons.push(`${short(action)} on existing table ${table} calls ${call}, which runs on every existing row`);
        } else if ((a = RE.addColumn.exec(action))) {
          if (!fresh && DESTRUCTIVE_FK.test(actionBare)) reasons.push(`adds a cascading foreign key to existing table ${table}`);
          else if (!fresh) creates.columns.push({ table, column: publicName(a[1]) });
          if (fresh) creates.newColumns.push(`${table}.${publicName(a[1])}`);
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
      const call = table && !newTables.has(table) ? unsafeCall(st.slice(m[0].length - 1)) : null;
      if (!table) reasons.push(`indexes a table outside public: ${short(st)}`);
      else if (call) reasons.push(`index on existing table ${table} calls ${call}`);
      else {
        if (!newTables.has(table)) creates.indexes.push(publicName(m[1]));
        newIndexes.add(publicName(m[1]));
      }
    } else if (RE.comment.test(st)) {
      // Checked after the pass: it may name a column or index created later in the file.
      comments.push(st);
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

  // A comment overwrites the object's previous one, which the inverse cannot
  // restore, so only objects this file creates may get one — in exactly the
  // `comment on table|column|index <name> is '<text>'` shape.
  const added = new Set([...creates.columns.map((c) => `${c.table}.${c.column}`), ...creates.newColumns]);
  for (const st of comments) {
    const c = new RegExp(String.raw`^comment\s+on\s+(table|column|index)\s+(${QNAME}(?:\s*\.\s*${IDENT})?)\s+is\s+'(?:[^']|'')*'$`, 'i').exec(st);
    const parts = c ? [...c[2].matchAll(new RegExp(IDENT, 'gi'))].map((x) => publicName(x[0]) ?? '') : [];
    if (c && parts[0] === 'public' && parts.length > (c[1].toLowerCase() === 'column' ? 2 : 1)) parts.shift();
    const target = parts.join('.');
    const ok = c && (
      (c[1].toLowerCase() === 'table' && parts.length === 1 && newTables.has(target)) ||
      (c[1].toLowerCase() === 'index' && parts.length === 1 && newIndexes.has(target)) ||
      (c[1].toLowerCase() === 'column' && parts.length === 2 && (newTables.has(parts[0]) || added.has(target)))
    );
    if (!ok) reasons.push(`comments on something this file does not create: ${short(st)}`);
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
