import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capsFrom, mailsSent, main, windowStart } from '../signup-cap-check.mjs';

const handler = readFileSync(fileURLToPath(new URL('../../api/_lib/handlers/signup.ts', import.meta.url)), 'utf8');
const creds = { url: 'https://prod.supabase.co', key: 'sb_secret_x' };
const NOW = Date.parse('2026-10-19T15:30:00Z');

function reply(rows: unknown, status = 200) {
  return vi.fn(async () => ({ ok: status === 200, status, json: async () => rows }));
}

let log: string[];
beforeEach(() => {
  log = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => { log.push(line); });
});
afterEach(() => vi.restoreAllMocks());

describe('signup-cap-check', () => {
  it("reads the caps out of the handler's own source", () => {
    expect(capsFrom(handler)).toEqual({ perDay: 50, perAddress: 3 });
    expect(() => capsFrom('const nothing = 1;')).toThrow(/MAILS_PER_DAY/);
  });

  it('starts the day where bump_rate_limit does: UTC midnight', () => {
    expect(windowStart(NOW)).toBe('2026-10-19T00:00:00.000Z');
  });

  it('counts each address for at most its own limit, as the handler does', () => {
    expect(mailsSent([{ count: 49 }, { count: 2 }], 3)).toBe(5);
  });

  it('under the cap: prints the tally and exits 0, reading only today\'s rows', async () => {
    const fetch = reply([{ count: 1 }, { count: 7 }]);
    expect(await main({ creds, fetch, now: NOW, source: handler })).toBe(0);
    expect(log).toEqual(['signup mails today: 4/50 (2 addresses)']);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toContain('/rest/v1/api_request_counts?bucket=eq.signup_mail');
    expect(url).toContain(`window_start=gte.${encodeURIComponent('2026-10-19T00:00:00.000Z')}`);
    expect(init.headers.apikey).toBe('sb_secret_x');
    // The key goes in headers only, never in what is printed.
    expect(log.join('\n')).not.toContain('sb_secret_x');
  });

  it('at the cap: exits 1, which the report turns into an ACTION', async () => {
    const rows = Array.from({ length: 17 }, () => ({ count: 3 }));
    expect(await main({ creds, fetch: reply(rows), now: NOW, source: handler })).toBe(1);
    expect(log[0]).toBe('signup mails today: 51/50 (17 addresses)');
  });

  it('cannot check: no credentials, a refused key or an outage is 2, never an ACTION', async () => {
    expect(await main({ creds: null, fetch: reply([]), source: handler })).toBe(2);
    expect(await main({ creds, fetch: reply({}, 401), source: handler })).toBe(2);
    const down = vi.fn(async () => { throw new Error('ENOTFOUND'); });
    expect(await main({ creds, fetch: down, source: handler })).toBe(2);
    expect(log.every(l => l.includes('skipped'))).toBe(true);
  });
});
