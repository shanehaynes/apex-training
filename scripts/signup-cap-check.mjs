#!/usr/bin/env node
// Today's open sign-up mails against the daily cap (docs/specs/open-signup.md
// M2). /api/signup (api/_lib/handlers/signup.ts) meters every mail in
// api_request_counts under bucket `signup_mail`, one row per address per UTC
// day. Each row counts for at most MAILS_PER_ADDRESS mails, because requests
// past an address's limit bump the row but send nothing. This sums the rows
// the way the handler does, so the number printed is the one the handler
// refuses at.
//
// The caps are read out of the handler's source rather than copied, so the
// report cannot drift from the code that enforces them.
//
// Credentials and exit codes follow scripts/prod-schema-check.mjs: 0 under
// the cap; 1 at the cap (sign-up is refusing people today);
// 2 could not check (no credentials, unreachable, key rejected).
// scripts/supervisor-report.sh prints 1 as an ACTION and 2 as status.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentials } from './prod-schema-check.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HANDLER = join(root, 'api', '_lib', 'handlers', 'signup.ts');
const DAY = 86400;

/** MAILS_PER_DAY and MAILS_PER_ADDRESS as the handler declares them. */
export function capsFrom(source) {
  const read = (name) => {
    const m = source.match(new RegExp(`export const ${name} = (\\d+);`));
    if (!m) throw new Error(`${name} not found in api/_lib/handlers/signup.ts`);
    return Number(m[1]);
  };
  return { perDay: read('MAILS_PER_DAY'), perAddress: read('MAILS_PER_ADDRESS') };
}

/** The UTC midnight bump_rate_limit's daily window starts at. */
export function windowStart(now = Date.now()) {
  return new Date(Math.floor(now / 1000 / DAY) * DAY * 1000).toISOString();
}

/** Mails sent today: each address's row capped at its own limit. */
export function mailsSent(rows, perAddress) {
  return rows.reduce((sum, r) => sum + Math.min(Number(r.count), perAddress), 0);
}

export async function main({ creds = credentials(), fetch = globalThis.fetch, now = Date.now(), source } = {}) {
  const caps = capsFrom(source ?? readFileSync(HANDLER, 'utf8'));
  if (!creds) {
    console.log('no production credentials — skipped');
    return 2;
  }
  const query = `bucket=eq.signup_mail&window_start=gte.${encodeURIComponent(windowStart(now))}&select=count`;
  let rows;
  try {
    const reply = await fetch(`${creds.url}/rest/v1/api_request_counts?${query}`, {
      headers: { apikey: creds.key, Authorization: `Bearer ${creds.key}` },
    });
    if (!reply.ok) {
      console.log(`could not read api_request_counts (HTTP ${reply.status}) — skipped`);
      return 2;
    }
    rows = await reply.json();
  } catch (err) {
    console.log(`production unreachable (${err instanceof Error ? err.message : err}) — skipped`);
    return 2;
  }
  const sent = mailsSent(rows, caps.perAddress);
  console.log(`signup mails today: ${sent}/${caps.perDay} (${rows.length} address${rows.length === 1 ? '' : 'es'})`);
  return sent >= caps.perDay ? 1 : 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.log(`signup-cap-check failed: ${err.message}`);
      process.exitCode = 3;
    },
  );
}
