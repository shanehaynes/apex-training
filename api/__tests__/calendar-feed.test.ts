import { describe, it, expect, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import feedHandler, { buildIcs, foldIcsLine } from '../calendar-feed';
import type { FeedEventRow, FeedExceptionRow } from '../calendar-feed';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));

function makeRow(overrides: Partial<FeedEventRow> & Pick<FeedEventRow, 'id' | 'date'>): FeedEventRow {
  return {
    type: 'stretching',
    title: 'Test Event',
    start_time: null,
    end_time: null,
    estimated_duration: 30,
    location: null,
    is_recurring: false,
    recurrence_rule: null,
    recurring_frequency: null,
    recurring_days: null,
    recurring_end_date: null,
    ...overrides,
  };
}

function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ ]/g, '').split('\r\n');
}

describe('buildIcs', () => {
  it('emits RRULE from the canonical recurrence_rule with an EXDATE per skipped instance', () => {
    const weekly = makeRow({
      id: 'climb', date: '2026-09-01', title: 'Climbing',
      start_time: '6:00 PM', end_time: '8:00 PM',
      is_recurring: true,
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261231',
    });
    const exceptions: FeedExceptionRow[] = [{ event_id: 'climb', skipped_date: '2026-09-08' }];

    const lines = unfold(buildIcs([weekly], exceptions));
    expect(lines).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261231');
    // Timed event → EXDATE matches DTSTART's value type and floating start time
    expect(lines).toContain('DTSTART:20260901T180000');
    expect(lines).toContain('EXDATE:20260908T180000');
  });

  it('emits date-typed EXDATE for all-day recurring events, sorted, comma-joined', () => {
    const daily = makeRow({
      id: 'stretch', date: '2026-09-01',
      is_recurring: true,
      recurrence_rule: 'FREQ=DAILY;UNTIL=20261001',
    });
    const exceptions: FeedExceptionRow[] = [
      { event_id: 'stretch', skipped_date: '2026-09-20' },
      { event_id: 'stretch', skipped_date: '2026-09-05' },
    ];

    const lines = unfold(buildIcs([daily], exceptions));
    expect(lines).toContain('DTSTART;VALUE=DATE:20260901');
    expect(lines).toContain('EXDATE;VALUE=DATE:20260905,20260920');
  });

  it('exceptions for one event never leak onto another', () => {
    const a = makeRow({ id: 'a', date: '2026-09-01', is_recurring: true, recurrence_rule: 'FREQ=DAILY;UNTIL=20261001' });
    const b = makeRow({ id: 'b', date: '2026-09-01', is_recurring: true, recurrence_rule: 'FREQ=DAILY;UNTIL=20261001' });
    const ics = buildIcs([a, b], [{ event_id: 'a', skipped_date: '2026-09-05' }]);
    expect(ics.match(/EXDATE/g)).toHaveLength(1);
  });

  it('never emits an invalid RRULE for legacy custom-frequency rows', () => {
    const custom = makeRow({
      id: 'legacy', date: '2026-09-01',
      is_recurring: true,
      recurring_frequency: 'custom',
      recurring_days: [2],
    });
    const ics = buildIcs([custom], []);
    expect(ics).not.toContain('RRULE');
    expect(ics).not.toContain('CUSTOM');
    expect(ics).toContain('UID:legacy@apex-training'); // still exported as a one-off
  });

  it('falls back to deprecated columns when recurrence_rule is not yet backfilled', () => {
    const legacyWeekly = makeRow({
      id: 'legacy-weekly', date: '2026-09-01',
      is_recurring: true,
      recurring_frequency: 'weekly',
      recurring_days: [1, 3, 5],
      recurring_end_date: '2026-12-31',
    });
    const lines = unfold(buildIcs([legacyWeekly], []));
    expect(lines).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261231');
  });

  it('emits every event exactly once (per-series model, no type-keyed skipping)', () => {
    const recurring = makeRow({ id: 'r', date: '2026-09-01', is_recurring: true, recurrence_rule: 'FREQ=DAILY;UNTIL=20261001' });
    // Same type, date inside the series window — a genuinely separate event
    const oneOff = makeRow({ id: 'solo', date: '2026-09-10' });
    const ics = buildIcs([recurring, oneOff], []);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain('UID:solo@apex-training');
  });

  it('all event datetimes stay floating: no TZID anywhere, no Z on DTSTART/DTEND/EXDATE/UNTIL', () => {
    const rows = [
      makeRow({ id: 'timed', date: '2026-09-01', start_time: '5:30 PM', end_time: '6:45 PM' }),
      makeRow({ id: 'allday', date: '2026-09-02' }),
      makeRow({ id: 'rec', date: '2026-09-03', start_time: '7:00 AM', is_recurring: true, recurrence_rule: 'FREQ=DAILY;UNTIL=20261001' }),
    ];
    const lines = unfold(buildIcs(rows, [{ event_id: 'rec', skipped_date: '2026-09-10' }]));

    expect(lines.join('\n')).not.toContain('TZID');
    for (const line of lines) {
      if (/^(DTSTART|DTEND|EXDATE|RRULE)/.test(line)) {
        expect(line, `event datetime line must be floating: ${line}`).not.toMatch(/Z\b|Z$/);
      }
    }
    // DTSTAMP is generation metadata and is correctly UTC — exactly one Z, not two
    const stampLine = lines.find(l => l.startsWith('DTSTAMP:'))!;
    expect(stampLine).toMatch(/^DTSTAMP:\d{8}T\d{6}Z$/);
  });

  it('computes DTEND from estimated_duration when end_time is missing', () => {
    const row = makeRow({ id: 'x', date: '2026-09-01', start_time: '11:45 PM', estimated_duration: 30 });
    const lines = unfold(buildIcs([row], []));
    expect(lines).toContain('DTSTART:20260901T234500');
    expect(lines).toContain('DTEND:20260901T001500'); // wraps past midnight (pre-existing behavior)
  });

  it('a CRLF in a title cannot inject ICS properties', () => {
    const evil = makeRow({ id: 'x', date: '2026-09-01', title: 'Legit\r\nATTENDEE:mailto:evil@x.y' });
    const physicalLines = buildIcs([evil], []).split('\r\n');
    expect(physicalLines.some(l => l.startsWith('ATTENDEE'))).toBe(false);
  });

  it('a CRLF in an event id cannot inject ICS properties via UID', () => {
    const evil = makeRow({ id: 'x\r\nATTENDEE:mailto:evil@x.y', date: '2026-09-01' });
    const physicalLines = buildIcs([evil], []).split('\r\n');
    expect(physicalLines.some(l => l.startsWith('ATTENDEE'))).toBe(false);
  });

  it('shifts DTEND by the start delta when only the start time is overridden', () => {
    const base = makeRow({
      id: 'climb', date: '2026-09-01', start_time: '6:00 PM', end_time: '8:00 PM',
      is_recurring: true, recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231',
    });
    const lines = unfold(buildIcs([base], [
      { event_id: 'climb', skipped_date: '2026-09-08', override_start_time: '7:00 PM' },
    ]));
    // The moved one-off keeps its 2h length instead of ending before it starts
    expect(lines).toContain('DTSTART:20260908T190000');
    expect(lines).toContain('DTEND:20260908T210000');
  });

  it('an explicit end override still wins', () => {
    const base = makeRow({
      id: 'climb', date: '2026-09-01', start_time: '6:00 PM', end_time: '8:00 PM',
      is_recurring: true, recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231',
    });
    const lines = unfold(buildIcs([base], [
      { event_id: 'climb', skipped_date: '2026-09-08', override_start_time: '7:00 PM', override_end_time: '7:30 PM' },
    ]));
    expect(lines).toContain('DTEND:20260908T193000');
  });
});

describe('foldIcsLine', () => {
  it('folds at 75 octets, not JS code units, without splitting characters', () => {
    const line = 'SUMMARY:' + '💪'.repeat(40); // 4 bytes each in UTF-8
    const folded = foldIcsLine(line);
    for (const physical of folded.split('\r\n')) {
      expect(Buffer.byteLength(physical, 'utf8')).toBeLessThanOrEqual(75);
      // No lone surrogates — every physical line must round-trip UTF-8 cleanly
      expect(Buffer.from(physical, 'utf8').toString('utf8')).toBe(physical);
    }
    // Unfolding restores the original content
    expect(folded.replace(/\r\n /g, '')).toBe(line);
  });

  it('leaves short lines untouched', () => {
    expect(foldIcsLine('BEGIN:VEVENT')).toBe('BEGIN:VEVENT');
  });
});

describe('feed token guard', () => {
  function makeRes() {
    let code: number | null = null;
    let payload: unknown;
    const res = {
      status(c: number) { code = c; return res; },
      send(b: unknown) { payload = b; return res; },
      json(b: unknown) { payload = b; return res; },
      setHeader() { return res; },
      end() { return res; },
    } as unknown as VercelResponse;
    return { res, statusCode: () => code, body: () => payload };
  }

  const req = (query: Record<string, string>) =>
    ({ method: 'GET', headers: {}, query } as unknown as VercelRequest);

  // ics_token is a UUID column: a malformed token used to reach Postgres and
  // come back as a 500. It must be rejected as the bad token it is, before
  // the query — so the throwing stub below is never touched.
  it('401s a non-UUID token without querying', async () => {
    const db = { from() { throw new Error('should not query'); } };
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>);
    const { res, statusCode, body } = makeRes();
    await feedHandler(req({ token: 'x' }), res);
    expect(statusCode()).toBe(401);
    expect(body()).toBe('Unknown feed token');
  });

  it('401s a missing token', async () => {
    const db = { from() { throw new Error('should not query'); } };
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>);
    const { res, statusCode } = makeRes();
    await feedHandler(req({}), res);
    expect(statusCode()).toBe(401);
  });

  it('lets a UUID-shaped token through to the lookup', async () => {
    let queried = false;
    const chain = {
      select() { return chain; },
      eq() { return chain; },
      maybeSingle: async () => ({ data: null, error: null }),
    };
    const db = { from() { queried = true; return chain; } };
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>);
    const { res, statusCode } = makeRes();
    await feedHandler(req({ token: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }), res);
    expect(queried).toBe(true);
    expect(statusCode()).toBe(401); // no such profile — but it got past the shape guard
  });
});
