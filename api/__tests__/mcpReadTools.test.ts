import { describe, it, expect, vi, afterEach } from 'vitest';
import type { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { getSessionSummariesTool } from '../_lib/mcp/tools/sessions';
import { getReviewsTool } from '../_lib/mcp/tools/reviews';
import { searchHistoryTool, snippetAround, queryTerms } from '../_lib/mcp/tools/history';
import { MCP_TOOLS } from '../_lib/mcp/toolRegistry';

// Tool-level tests for the coach's history readers (A01). Same posture as
// mcpTools.test.ts — fixture rows in, payloads out, no handler — but this
// stub applies the filters instead of passing them through, because these
// tools lean on the query (date windows, user scoping, a text search, a
// limit) rather than on a pure function over a drained table.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;
type Row = Record<string, unknown>;

interface StubOptions {
  /** Tables whose every query rejects — how search_history's degradation is exercised. */
  failing?: string[];
}

function makeAdmin(fixtures: Record<string, Row[]>, options: StubOptions = {}): Admin {
  return {
    from(table: string) {
      let rows = [...(fixtures[table] ?? [])];
      let from = 0;
      let to = Infinity;
      const builder: Record<string, unknown> = {};
      const keep = (pred: (r: Row) => boolean) => {
        rows = rows.filter(pred);
        return builder;
      };
      const str = (v: unknown) => (v == null ? '' : String(v));
      builder.select = () => builder;
      builder.eq = (c: string, v: unknown) => keep(r => r[c] === v);
      builder.neq = (c: string, v: unknown) => keep(r => r[c] !== v);
      builder.gte = (c: string, v: string) => keep(r => str(r[c]) >= v);
      builder.lte = (c: string, v: string) => keep(r => str(r[c]) <= v);
      builder.lt = (c: string, v: string) => keep(r => str(r[c]) < v);
      builder.is = (c: string, v: unknown) => keep(r => r[c] === v);
      builder.not = (c: string, op: string, v: unknown) => {
        if (op !== 'is') throw new Error(`unmocked not.${op}`);
        return keep(r => r[c] !== v);
      };
      builder.in = (c: string, values: unknown[]) => keep(r => values.includes(r[c]));
      // websearch, approximated: every quoted-or-bare term must appear.
      builder.textSearch = (c: string, query: string) => {
        const terms = queryTerms(query);
        return keep(r => terms.every(t => str(r[c]).toLowerCase().includes(t)));
      };
      builder.order = (c: string, opts: { ascending?: boolean; nullsFirst?: boolean } = {}) => {
        const asc = opts.ascending !== false;
        rows.sort((a, b) => {
          const av = a[c];
          const bv = b[c];
          if (av == null || bv == null) {
            if (av == null && bv == null) return 0;
            const nullsFirst = opts.nullsFirst ?? !asc;
            return (av == null ? -1 : 1) * (nullsFirst ? 1 : -1);
          }
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return asc ? cmp : -cmp;
        });
        return builder;
      };
      builder.limit = (n: number) => {
        to = Math.min(to, from + n - 1);
        return builder;
      };
      builder.range = (f: number, t: number) => {
        from = f;
        to = t;
        return builder;
      };
      builder.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
      builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        (options.failing?.includes(table)
          ? Promise.resolve({ data: null, error: { message: `${table} is on fire` } })
          : Promise.resolve({ data: rows.slice(from, to + 1), error: null })
        ).then(resolve, reject);
      return builder;
    },
  } as unknown as Admin;
}

const USER = 'user-123';

const session = (id: string, date: string, summary: string | null, extra: Row = {}): Row => ({
  id,
  user_id: USER,
  event_id: `evt-${id}`,
  event_date: date,
  started_at: `${date}T10:00:00Z`,
  finished_at: `${date}T11:05:00Z`,
  total_duration_seconds: null,
  coach_summary: summary,
  template_id: null,
  ...extra,
});

describe('get_session_summaries', () => {
  const fixtures = {
    workout_sessions: [
      session('s1', '2026-09-01', 'Solid squat day; bar speed held on the last set.', { total_duration_seconds: 3720 }),
      session('s2', '2026-09-10', null), // no summary → excluded
      session('s3', '2026-09-15', ''), // empty summary → excluded
      session('s4', '2026-09-20', 'Easy zone-2 spin, HR drifted late.', { event_id: 'evt-ride__2026-09-20' }),
      session('s5', '2026-07-01', 'Old block: deload week.'), // outside the default 30-day window
      { ...session('s6', '2026-09-21', 'Not yours.'), user_id: 'someone-else' },
    ],
    workout_completions: [
      { user_id: USER, event_id: 'evt-s1', event_date: '2026-09-01', event_title: 'Lower A' },
    ],
    workout_events: [
      { id: 'evt-ride', user_id: USER, title: 'Zone 2 Ride' },
    ],
  };

  it('returns rows with a non-empty summary, newest first, titled through completions then events', async () => {
    const payload = (await getSessionSummariesTool.run(makeAdmin(fixtures), USER, {
      start: '2026-08-25',
      end: '2026-09-25',
    })) as { sessions: Array<{ date: string; eventId: string; title: string; durationMinutes: number | null; summary: string }> };

    expect(payload.sessions.map(s => s.date)).toEqual(['2026-09-20', '2026-09-01']);
    expect(payload.sessions[0]).toEqual({
      date: '2026-09-20',
      eventId: 'evt-ride__2026-09-20',
      title: 'Zone 2 Ride', // no completion row → base event title via baseIdOf
      durationMinutes: 65, // finished_at − started_at
      summary: 'Easy zone-2 spin, HR drifted late.',
    });
    expect(payload.sessions[1]).toMatchObject({ title: 'Lower A', durationMinutes: 62 }); // 3720 s, stored duration wins
  });

  it('defaults to the last 30 days and honours limit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    try {
      const payload = (await getSessionSummariesTool.run(makeAdmin(fixtures), USER, {})) as {
        start: string; end: string; sessions: Array<{ date: string }>;
      };
      expect(payload).toMatchObject({ start: '2026-08-26', end: '2026-09-25' });
      expect(payload.sessions.map(s => s.date)).toEqual(['2026-09-20', '2026-09-01']);

      const limited = (await getSessionSummariesTool.run(makeAdmin(fixtures), USER, { limit: 1 })) as {
        sessions: Array<{ date: string }>;
      };
      expect(limited.sessions.map(s => s.date)).toEqual(['2026-09-20']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to "Workout" when neither a completion nor the event names it', async () => {
    const payload = (await getSessionSummariesTool.run(
      makeAdmin({ workout_sessions: [session('s9', '2026-09-02', 'Untitled effort.')] }),
      USER,
      { start: '2026-09-01', end: '2026-09-03' },
    )) as { sessions: Array<{ title: string }> };
    expect(payload.sessions[0].title).toBe('Workout');
  });

  it('rejects malformed arguments', async () => {
    const admin = makeAdmin(fixtures);
    await expect(getSessionSummariesTool.run(admin, USER, { start: 'yesterday' })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(getSessionSummariesTool.run(admin, USER, { start: '2026-09-10', end: '2026-09-01' }))
      .rejects.toThrow('end must be on or after start.');
    await expect(getSessionSummariesTool.run(admin, USER, { limit: 51 })).rejects.toThrow(/between 1 and 50/);
  });
});

const review = (id: string, periodType: 'month' | 'year', isoYear: number, monthIndex: number | null, extra: Row = {}): Row => ({
  id,
  user_id: USER,
  period_type: periodType,
  iso_year: isoYear,
  month_index: monthIndex,
  stats: { totals: { sessionsCompleted: 12 } },
  ai_commentary: `Commentary for ${id}`,
  email_sent_at: null,
  email_skipped_reason: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...extra,
});

describe('get_reviews', () => {
  const fixtures = {
    reviews: [
      review('r-2025', 'year', 2025, null),
      review('r-2026-01', 'month', 2026, 1),
      review('r-2026-08', 'month', 2026, 8, { ai_commentary: null }),
      review('r-2026-07', 'month', 2026, 7),
      { ...review('r-other', 'month', 2026, 9), user_id: 'someone-else' },
    ],
  };

  it('lists both kinds newest first by period start, with labels from the shared period builder', async () => {
    const payload = (await getReviewsTool.run(makeAdmin(fixtures), USER, {})) as {
      reviews: Array<{ kind: string; periodLabel: string; startDate: string; commentary: string | null; stats: unknown }>;
    };
    expect(payload.reviews.map(r => [r.kind, r.startDate])).toEqual([
      ['month', '2026-07-13'], // ISO month 8 of 2026
      ['month', '2026-06-15'], // month 7
      ['month', '2025-12-29'], // month 1 (ISO year 2026 starts on Dec 29)
      ['year', '2024-12-30'], // ISO year 2025
    ]);
    expect(payload.reviews[0]).toMatchObject({
      periodLabel: 'Jul 13 – Aug 9, 2026',
      commentary: null,
      stats: { totals: { sessionsCompleted: 12 } },
    });
    expect(payload.reviews[3].periodLabel).toBe('2025');
  });

  it('filters by kind and caps at limit', async () => {
    const months = (await getReviewsTool.run(makeAdmin(fixtures), USER, { kind: 'month', limit: 2 })) as {
      reviews: Array<{ kind: string; startDate: string }>;
    };
    expect(months.reviews.map(r => r.startDate)).toEqual(['2026-07-13', '2026-06-15']);

    const years = (await getReviewsTool.run(makeAdmin(fixtures), USER, { kind: 'year' })) as {
      reviews: Array<{ kind: string; periodLabel: string }>;
    };
    expect(years.reviews).toEqual([expect.objectContaining({ kind: 'year', periodLabel: '2025' })]);
  });

  it('rejects malformed arguments', async () => {
    const admin = makeAdmin(fixtures);
    await expect(getReviewsTool.run(admin, USER, { kind: 'week' })).rejects.toThrow(/kind must be one of/);
    await expect(getReviewsTool.run(admin, USER, { limit: 13 })).rejects.toThrow(/between 1 and 12/);
  });
});

describe('search_history', () => {
  afterEach(() => vi.restoreAllMocks());

  const fixtures = {
    coach_messages: [
      { id: 'm1', user_id: USER, conversation_id: 'c1', role: 'user', kind: 'turn',
        display_text: 'My left shoulder has been clicking on overhead press.', created_at: '2026-09-10T08:00:00Z' },
      { id: 'm2', user_id: USER, conversation_id: 'c1', role: 'assistant', kind: 'turn',
        display_text: 'Let\'s swap overhead press for a landmine press until the left shoulder settles.', created_at: '2026-09-10T08:01:00Z' },
      // A notice, not a turn — never searched.
      { id: 'm3', user_id: USER, conversation_id: 'c1', role: 'assistant', kind: 'notice',
        display_text: 'left shoulder notice', created_at: '2026-09-11T08:00:00Z' },
      { id: 'm4', user_id: 'someone-else', conversation_id: 'c9', role: 'user', kind: 'turn',
        display_text: 'left shoulder, but not this user', created_at: '2026-09-12T08:00:00Z' },
    ],
    workout_sessions: [
      session('s1', '2026-09-08', 'Pressed lighter; the left shoulder was talkative in the warmup.'),
      session('s2', '2026-09-20', 'Great ride, nothing to report.'),
    ],
    reviews: [
      review('r1', 'month', 2026, 8, { ai_commentary: 'The left shoulder niggle shaped the pressing volume this month.', created_at: '2026-08-10T00:00:00Z' }),
    ],
    objectives: [
      { id: 'o1', user_id: USER, name: 'Rainier', notes: 'Keep the left shoulder healthy for the axe work.', updated_at: '2026-06-01T00:00:00Z' },
    ],
  };

  it('searches every kind, scoped to the user and to conversation turns, newest first', async () => {
    const payload = (await searchHistoryTool.run(makeAdmin(fixtures), USER, { query: 'left shoulder' })) as {
      results: Array<{ kind: string; sourceId: string; date: string; snippet: string }>;
    };
    expect(payload.results.map(r => [r.kind, r.sourceId, r.date])).toEqual([
      ['message', 'm2', '2026-09-10'],
      ['message', 'm1', '2026-09-10'],
      ['session_summary', 's1', '2026-09-08'],
      ['review', 'r1', '2026-08-10'],
      ['objective', 'o1', '2026-06-01'],
    ]);
    expect(payload.results[1].snippet).toBe('My left shoulder has been clicking on overhead press.');
  });

  it('narrows by kinds and by date window', async () => {
    const admin = makeAdmin(fixtures);
    const kinds = (await searchHistoryTool.run(admin, USER, { query: 'left shoulder', kinds: ['objective', 'review'] })) as {
      results: Array<{ kind: string }>;
    };
    expect(kinds.results.map(r => r.kind)).toEqual(['review', 'objective']);

    const dated = (await searchHistoryTool.run(admin, USER, { query: 'left shoulder', start: '2026-09-01', end: '2026-09-10' })) as {
      results: Array<{ sourceId: string }>;
    };
    // end is inclusive: both 2026-09-10 turns are in; the review and objective are before the window.
    expect(dated.results.map(r => r.sourceId)).toEqual(['m2', 'm1', 's1']);
  });

  it('degrades to fewer results when one source fails, and says so on the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const payload = (await searchHistoryTool.run(makeAdmin(fixtures, { failing: ['coach_messages'] }), USER, {
      query: 'left shoulder',
    })) as { results: Array<{ kind: string }> };
    expect(payload.results.map(r => r.kind)).toEqual(['session_summary', 'review', 'objective']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('search_history: message search failed'),
      'coach_messages is on fire',
    );
  });

  it('honours limit across kinds', async () => {
    const payload = (await searchHistoryTool.run(makeAdmin(fixtures), USER, { query: 'left shoulder', limit: 2 })) as {
      results: Array<{ sourceId: string }>;
    };
    expect(payload.results.map(r => r.sourceId)).toEqual(['m2', 'm1']);
  });

  it('rejects malformed arguments', async () => {
    const admin = makeAdmin(fixtures);
    await expect(searchHistoryTool.run(admin, USER, {})).rejects.toThrow('query must be a non-empty string.');
    await expect(searchHistoryTool.run(admin, USER, { query: 'x'.repeat(201) })).rejects.toThrow(/at most 200 characters/);
    await expect(searchHistoryTool.run(admin, USER, { query: 'ok', kinds: ['diary'] })).rejects.toThrow(/kinds must be/);
    await expect(searchHistoryTool.run(admin, USER, { query: 'ok', kinds: [] })).rejects.toThrow(/kinds must be/);
    await expect(searchHistoryTool.run(admin, USER, { query: 'ok', start: '2026-09-10', end: '2026-09-01' }))
      .rejects.toThrow('end must be on or after start.');
    await expect(searchHistoryTool.run(admin, USER, { query: 'ok', limit: 31 })).rejects.toThrow(/between 1 and 30/);
  });

  it('is not an MCP tool, while the two history readers are (appended, in order)', () => {
    const names = MCP_TOOLS.map(t => t.name);
    expect(names).not.toContain('search_history');
    expect(names.slice(-2)).toEqual(['get_session_summaries', 'get_reviews']);
  });
});

describe('snippetAround', () => {
  it('returns short text verbatim with whitespace collapsed', () => {
    expect(snippetAround('a  short\n\nnote', 'note')).toBe('a short note');
  });

  it('centres a long text on the first matching term and stays within the budget', () => {
    const text = `${'x'.repeat(300)} the shoulder felt fine ${'y'.repeat(300)}`;
    const out = snippetAround(text, 'shoulder');
    expect(out.length).toBe(240);
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect(out).toContain('the shoulder felt fine');
  });

  it('finds a stemmed term by its prefix, and shows the opening when nothing matches', () => {
    const text = `${'x'.repeat(300)} the shoulders felt fine ${'y'.repeat(300)}`;
    expect(snippetAround(text, 'shoulder')).toContain('shoulders felt fine');
    const miss = snippetAround(text, 'knee');
    expect(miss.length).toBe(240);
    expect(miss.startsWith('xxx')).toBe(true);
    expect(miss.endsWith('…')).toBe(true);
  });

  it('ignores websearch operators when locating the match', () => {
    expect(queryTerms('"left shoulder" -press or knee')).toEqual(['left', 'shoulder', 'knee']);
  });
});
