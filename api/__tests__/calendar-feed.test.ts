import { describe, it, expect } from 'vitest';
import { buildIcs } from '../calendar-feed';
import type { FeedEventRow, FeedExceptionRow } from '../calendar-feed';

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
});
