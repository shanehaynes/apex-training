import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../review-cron';
import { getAnthropicKey } from '../_lib/anthropicKey';
import {
  createReview,
  deleteReview,
  fetchReviewInputs,
  getReview,
  listRecipients,
  markEmailSent,
  markEmailSkipped,
  saveCommentary,
} from '../_lib/reviewData';
import { sendReviewEmail } from '../_lib/mailer';
import type { ReviewRow, CompletionRow } from '../../src/lib/db/types';
import { buildReviewPeriod, computeReviewStats } from '../../src/lib/review/stats';

const { messagesCreate } = vi.hoisted(() => ({ messagesCreate: vi.fn() }));

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn(() => ({})) }));
vi.mock('../_lib/anthropicKey.js', () => ({ getAnthropicKey: vi.fn() }));
vi.mock('../_lib/mailer.js', () => ({ sendReviewEmail: vi.fn() }));
vi.mock('../_lib/reviewData.js', () => ({
  fetchReviewInputs: vi.fn(),
  listRecipients: vi.fn(),
  getReview: vi.fn(),
  createReview: vi.fn(),
  deleteReview: vi.fn(),
  saveCommentary: vi.fn(),
  markEmailSent: vi.fn(),
  markEmailSkipped: vi.fn(),
}));
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: messagesCreate };
  }
  return { default: MockAnthropic };
});

const mockedListRecipients = vi.mocked(listRecipients);
const mockedGetReview = vi.mocked(getReview);
const mockedDeleteReview = vi.mocked(deleteReview);
const mockedCreateReview = vi.mocked(createReview);
const mockedFetchInputs = vi.mocked(fetchReviewInputs);
const mockedGetKey = vi.mocked(getAnthropicKey);
const mockedSend = vi.mocked(sendReviewEmail);
const mockedMarkSent = vi.mocked(markEmailSent);
const mockedMarkSkipped = vi.mocked(markEmailSkipped);
const mockedSaveCommentary = vi.mocked(saveCommentary);

// Tests pin the period explicitly (month 6 of ISO 2026: May 18 – Jun 14) so
// they don't depend on the wall clock.
const PERIOD_QUERY = { periodType: 'month', isoYear: '2026', monthIndex: '6' };

function makeCompletion(date: string): CompletionRow {
  return {
    event_id: `evt-${date}`,
    event_date: date,
    event_type: 'weights',
    event_title: 'weights session',
    duration_minutes: 60,
    is_completed: true,
    completed_at: `${date}T12:00:00Z`,
    updated_at: `${date}T12:00:00Z`,
  };
}

const activeMonthStats = () =>
  computeReviewStats({
    period: buildReviewPeriod('month', 2026, 6),
    completions: [makeCompletion('2026-05-20')],
    sessions: [],
    setLogs: [],
    cardioLogs: [],
  });

function makeRow(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    id: 'review-1',
    user_id: 'user-1',
    period_type: 'month',
    iso_year: 2026,
    month_index: 6,
    stats: activeMonthStats(),
    ai_commentary: null,
    email_sent_at: null,
    email_skipped_reason: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeReq(query: Record<string, string> = {}, auth: string | null = 'Bearer test-secret'): VercelRequest {
  return { method: 'GET', headers: auth ? { authorization: auth } : {}, query } as unknown as VercelRequest;
}

function makeRes() {
  let code: number | null = null;
  let payload: unknown;
  const res = {
    status(c: number) { code = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
  } as unknown as VercelResponse;
  return { res, statusCode: () => code, body: () => payload as { processed?: Array<{ action: string }>; errors?: unknown[] } };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = 'test-secret';
  mockedListRecipients.mockResolvedValue([{ userId: 'user-1', email: 'shane@example.com', displayName: 'Shane' }]);
  mockedGetReview.mockResolvedValue(null);
  mockedFetchInputs.mockImplementation(async (_supabase, _userId, period) => ({
    period,
    completions: [makeCompletion('2026-05-20')],
    sessions: [],
    setLogs: [],
    cardioLogs: [],
  }));
  mockedCreateReview.mockImplementation(async (_supabase, params) => makeRow({ stats: params.stats }));
  mockedGetKey.mockResolvedValue(null);
  mockedSend.mockResolvedValue(undefined);
});

describe('auth', () => {
  it('rejects a missing or wrong bearer token', async () => {
    for (const auth of [null, 'Bearer wrong']) {
      const { res, statusCode } = makeRes();
      await handler(makeReq(PERIOD_QUERY, auth), res);
      expect(statusCode()).toBe(401);
    }
    expect(mockedListRecipients).not.toHaveBeenCalled();
  });

  it('rejects everything when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    const { res, statusCode } = makeRes();
    await handler(makeReq(PERIOD_QUERY), res);
    expect(statusCode()).toBe(401);
  });
});

describe('idempotency', () => {
  it('skips a review that was already emailed — the double-send guard', async () => {
    mockedGetReview.mockResolvedValue(makeRow({ email_sent_at: '2026-06-15T14:00:00Z' }));
    const { res, body } = makeRes();
    await handler(makeReq(PERIOD_QUERY), res);
    expect(body().processed).toEqual([{ userId: 'user-1', period: '2026-M6', action: 'already-done' }]);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedCreateReview).not.toHaveBeenCalled();
  });

  it('skips a review already marked skipped', async () => {
    mockedGetReview.mockResolvedValue(makeRow({ email_skipped_reason: 'no-activity' }));
    const { res, body } = makeRes();
    await handler(makeReq(PERIOD_QUERY), res);
    expect(body().processed?.[0]?.action).toBe('already-done');
    expect(mockedSend).not.toHaveBeenCalled();
  });
});

describe('generation and delivery', () => {
  it('computes, stores, and sends stats-only when the user has no Anthropic key', async () => {
    const { res, body } = makeRes();
    await handler(makeReq(PERIOD_QUERY), res);
    expect(mockedCreateReview).toHaveBeenCalledOnce();
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(mockedSend).toHaveBeenCalledOnce();
    const email = mockedSend.mock.calls[0][0];
    expect(email.to).toBe('shane@example.com');
    expect(email.subject).toContain('training month in review');
    expect(email.html).not.toContain('your coach');
    expect(mockedMarkSent).toHaveBeenCalledWith(expect.anything(), 'review-1');
    expect(body().processed?.[0]?.action).toBe('sent');
  });

  it('generates and saves AI commentary when a key exists', async () => {
    mockedGetKey.mockResolvedValue('sk-ant-test');
    messagesCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Strong month. Keep stacking weeks.' }] });
    const { res, body } = makeRes();
    await handler(makeReq(PERIOD_QUERY), res);
    expect(mockedSaveCommentary).toHaveBeenCalledWith(expect.anything(), 'review-1', 'Strong month. Keep stacking weeks.');
    expect(mockedSend.mock.calls[0][0].html).toContain('Strong month. Keep stacking weeks.');
    expect(body().processed?.[0]?.action).toBe('sent');
  });

  it('holds the email for retry when the AI call fails on a fresh row', async () => {
    mockedGetKey.mockResolvedValue('sk-ant-test');
    messagesCreate.mockRejectedValue(new Error('overloaded'));
    const { res, body } = makeRes();
    await handler(makeReq(PERIOD_QUERY), res);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedMarkSent).not.toHaveBeenCalled();
    expect(body().processed?.[0]?.action).toBe('ai-retry');
    expect(body().errors).toHaveLength(1);
  });

  it('falls back to stats-only when AI keeps failing past the retry window', async () => {
    const staleCreatedAt = new Date(Date.now() - 4 * 86_400_000).toISOString();
    mockedGetReview.mockResolvedValue(makeRow({ created_at: staleCreatedAt }));
    mockedGetKey.mockResolvedValue('sk-ant-test');
    messagesCreate.mockRejectedValue(new Error('revoked key'));
    const { res, body } = makeRes();
    await handler(makeReq(PERIOD_QUERY), res);
    expect(mockedSend).toHaveBeenCalledOnce();
    expect(mockedSend.mock.calls[0][0].html).not.toContain('your coach');
    expect(body().processed?.[0]?.action).toBe('sent');
  });

  it('leaves the row pending when the email send fails, so tomorrow retries send-only', async () => {
    mockedSend.mockRejectedValue(new Error('SMTP send failed'));
    const { res, body } = makeRes();
    await handler(makeReq(PERIOD_QUERY), res);
    expect(mockedMarkSent).not.toHaveBeenCalled();
    expect(body().errors).toHaveLength(1);
  });

  it('records no-activity periods without sending', async () => {
    mockedFetchInputs.mockImplementation(async (_supabase, _userId, period) => ({
      period,
      completions: [],
      sessions: [],
      setLogs: [],
      cardioLogs: [],
    }));
    const { res, body } = makeRes();
    await handler(makeReq(PERIOD_QUERY), res);
    expect(mockedCreateReview).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ emailSkippedReason: 'no-activity' }),
    );
    expect(mockedSend).not.toHaveBeenCalled();
    expect(body().processed?.[0]?.action).toBe('skipped-no-activity');
  });

  it('marks no-email users skipped instead of failing', async () => {
    mockedListRecipients.mockResolvedValue([{ userId: 'user-1', email: null, displayName: 'Shane' }]);
    const { res, body } = makeRes();
    await handler(makeReq(PERIOD_QUERY), res);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedMarkSkipped).toHaveBeenCalledWith(expect.anything(), 'review-1', 'no-email');
    expect(body().processed?.[0]?.action).toBe('skipped-no-email');
  });
});

describe('dry run', () => {
  it('returns stats, recap, and subject with no writes, AI, or email', async () => {
    const { res, statusCode, body } = makeRes();
    await handler(makeReq({ ...PERIOD_QUERY, userId: 'user-1', dryRun: '1' }), res);
    expect(statusCode()).toBe(200);
    const payload = body() as unknown as { stats: unknown; recap: string; subject: string };
    expect(payload.subject).toContain('training month in review');
    expect(payload.recap).toContain('Sessions completed: 1');
    expect(mockedCreateReview).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(mockedGetKey).not.toHaveBeenCalled();
  });

  it('requires an explicit user and period', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({ ...PERIOD_QUERY, dryRun: '1' }), res);
    expect(statusCode()).toBe(400);
  });
});

describe('force regenerate', () => {
  it('deletes the stored row for the target period, then recomputes and re-sends', async () => {
    const { res, body } = makeRes();
    await handler(makeReq({ ...PERIOD_QUERY, userId: 'user-1', force: '1' }), res);
    expect(mockedDeleteReview).toHaveBeenCalledWith(expect.anything(), 'user-1', 'month', 2026, 6);
    expect(mockedSend).toHaveBeenCalledOnce();
    expect(body().processed?.[0]?.action).toBe('sent');
  });

  it('refuses to force without an explicit user and period', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({ force: '1' }), res); // no userId, no explicit period
    expect(statusCode()).toBe(400);
    expect(mockedDeleteReview).not.toHaveBeenCalled();
  });
});

describe('period validation', () => {
  it('rejects a month without monthIndex', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({ periodType: 'month', isoYear: '2026' }), res);
    expect(statusCode()).toBe(400);
  });

  it('rejects monthIndex on a year period', async () => {
    const { res, statusCode } = makeRes();
    await handler(makeReq({ periodType: 'year', isoYear: '2026', monthIndex: '3' }), res);
    expect(statusCode()).toBe(400);
  });
});
