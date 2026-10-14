import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../review-cron';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';
import { getAnthropicKey } from '../_lib/anthropicKey';
import { createReview, fetchReviewInputs, getReview, listRecipients } from '../_lib/reviewData';
import { sendReviewEmail } from '../_lib/mailer';
import type { CompletionRow, ReviewRow } from '../../src/lib/db/types';

// The monthly/yearly recap commentary writes one coach_runs row per model
// call (phase57): mode 'recap', the recipient's model, the token counts, and
// `error` when the call throws.

const { messagesCreate } = vi.hoisted(() => ({ messagesCreate: vi.fn() }));

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
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
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create: messagesCreate }; },
}));

let runs: Array<Record<string, unknown>>;

const completion: CompletionRow = {
  event_id: 'evt-1', event_date: '2026-05-20', event_type: 'weights', event_title: 'weights session',
  duration_minutes: 60, is_completed: true, completed_at: '2026-05-20T12:00:00Z', updated_at: '2026-05-20T12:00:00Z',
};

const req = {
  method: 'GET',
  headers: { authorization: 'Bearer test-secret' },
  query: { periodType: 'month', isoYear: '2026', monthIndex: '6' },
} as unknown as VercelRequest;

function makeRes() {
  const res = { status() { return res; }, send() { return res; }, json() { return res; } } as unknown as VercelResponse;
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  runs = [];
  process.env.CRON_SECRET = 'test-secret';
  vi.mocked(getSupabaseAdmin).mockReturnValue({
    from: (table: string) => {
      expect(table).toBe('coach_runs');
      return { insert: async (row: Record<string, unknown>) => { runs.push(row); return { error: null }; } };
    },
  } as never);
  vi.mocked(listRecipients).mockResolvedValue([{ userId: 'user-1', email: 'a@example.com', displayName: 'A', coachModel: 'claude-haiku-4-5' }]);
  vi.mocked(getReview).mockResolvedValue(null);
  vi.mocked(fetchReviewInputs).mockImplementation(async (_s, _u, period) => ({
    period, completions: [completion], sessions: [], setLogs: [], cardioLogs: [],
  }));
  vi.mocked(createReview).mockImplementation(async (_s, params) => ({
    id: 'review-1', user_id: 'user-1', period_type: 'month', iso_year: 2026, month_index: 6, stats: params.stats,
    ai_commentary: null, email_sent_at: null, email_skipped_reason: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  } as ReviewRow));
  vi.mocked(getAnthropicKey).mockResolvedValue('sk-ant-user-1');
  vi.mocked(sendReviewEmail).mockResolvedValue(undefined);
});

describe('review-cron coach_runs rows', () => {
  it('records the recap call with its token counts', async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Strong month.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1500, output_tokens: 220, cache_read_input_tokens: 0, cache_creation_input_tokens: 11 },
    });
    await handler(req, makeRes());
    expect(runs).toEqual([{
      user_id: 'user-1',
      mode: 'recap',
      model: messagesCreate.mock.calls[0][0].model,
      prompt_version: expect.stringMatching(/^[0-9a-f]{12}$/),
      client: 'cron',
      with_tools: false,
      request_id: expect.any(String),
      input_tokens: 1500,
      cache_read_tokens: 0,
      cache_write_tokens: 11,
      output_tokens: 220,
      stop_reason: 'end_turn',
      latency_ms: expect.any(Number),
    }]);
    expect(JSON.stringify(runs)).not.toContain('Strong month.');
  });

  it('records a recap call that throws', async () => {
    messagesCreate.mockRejectedValue(new Error('overloaded'));
    await handler(req, makeRes());
    expect(runs).toEqual([expect.objectContaining({ mode: 'recap', user_id: 'user-1', error: 'overloaded' })]);
  });

  it('writes no row when the user has no key', async () => {
    vi.mocked(getAnthropicKey).mockResolvedValue(null);
    await handler(req, makeRes());
    expect(runs).toEqual([]);
  });
});
