import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../profile';
import { keyLast4 } from '../_lib/anthropicKey';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';

const { modelsList } = vi.hoisted(() => ({ modelsList: vi.fn() }));

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('@anthropic-ai/sdk', () => {
  class AuthenticationError extends Error {}
  class PermissionDeniedError extends Error {}
  class MockAnthropic {
    static AuthenticationError = AuthenticationError;
    static PermissionDeniedError = PermissionDeniedError;
    models = { list: modelsList };
  }
  return { default: MockAnthropic };
});

const mockedAdmin = vi.mocked(getSupabaseAdmin);

interface AdminState {
  key: string | null;
  upserted?: Record<string, unknown>;
  deleted?: boolean;
  profileUpdate?: Record<string, unknown>;
}

// Minimal chainable fake covering exactly the query shapes profile.ts uses.
function makeAdmin(state: AdminState) {
  return {
    from(table: string) {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: state.key ? { anthropic_api_key: state.key } : null,
              error: null,
            }),
          }),
        }),
        upsert: async (row: Record<string, unknown>) => {
          state.upserted = row;
          state.key = row.anthropic_api_key as string;
          return { error: null };
        },
        delete: () => ({
          eq: async () => {
            state.deleted = true;
            state.key = null;
            return { error: null };
          },
        }),
        update: (row: Record<string, unknown>) => ({
          eq: async () => {
            if (table === 'profiles') state.profileUpdate = row;
            return { error: null };
          },
        }),
      };
    },
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;
}

function makeReq(method: string, body?: unknown): VercelRequest {
  return { method, headers: {}, body } as unknown as VercelRequest;
}

function makeRes() {
  let code: number | null = null;
  let payload: unknown;
  const res = {
    status(c: number) { code = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
  } as unknown as VercelResponse;
  return { res, statusCode: () => code, body: () => payload };
}

beforeEach(() => {
  modelsList.mockReset();
  mockedAdmin.mockReset();
});

describe('keyLast4', () => {
  it('returns the last four characters', () => {
    expect(keyLast4('sk-ant-api03-xyz-wxyz')).toBe('wxyz');
  });
});

describe('GET /api/profile', () => {
  it('reports no key when none is stored', async () => {
    mockedAdmin.mockReturnValue(makeAdmin({ key: null }));
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('GET'), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ hasAnthropicKey: false, anthropicKeyLast4: null });
  });

  it('reports masked last-4 when a key is stored — never the key itself', async () => {
    mockedAdmin.mockReturnValue(makeAdmin({ key: 'sk-ant-api03-secret-tail' }));
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('GET'), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ hasAnthropicKey: true, anthropicKeyLast4: 'tail' });
    expect(JSON.stringify(body())).not.toContain('secret');
  });
});

describe('PATCH /api/profile — anthropic_api_key', () => {
  it('rejects malformed keys without calling Anthropic', async () => {
    const state: AdminState = { key: null };
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH', { anthropic_api_key: 'not-a-key' }), res);
    expect(statusCode()).toBe(400);
    expect(modelsList).not.toHaveBeenCalled();
    expect(state.upserted).toBeUndefined();
  });

  it('live-validates then upserts a good key; response has last4, not the key', async () => {
    modelsList.mockResolvedValue({ data: [] });
    const state: AdminState = { key: null };
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode, body } = makeRes();
    const key = 'sk-ant-api03-good-key-value-abcd';
    await handler(makeReq('PATCH', { anthropic_api_key: key }), res);
    expect(statusCode()).toBe(200);
    expect(modelsList).toHaveBeenCalledOnce();
    expect(state.upserted).toMatchObject({ user_id: 'user-123', anthropic_api_key: key });
    expect(body()).toMatchObject({ ok: true, hasAnthropicKey: true, anthropicKeyLast4: 'abcd' });
    expect(JSON.stringify(body())).not.toContain(key);
  });

  it('400s when Anthropic rejects the key, without storing it', async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    modelsList.mockRejectedValue(new Anthropic.AuthenticationError('bad'));
    const state: AdminState = { key: null };
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('PATCH', { anthropic_api_key: 'sk-ant-api03-revoked-key-0000' }), res);
    expect(statusCode()).toBe(400);
    expect(String(body())).toContain('rejected');
    expect(String(body())).not.toContain('revoked-key');
    expect(state.upserted).toBeUndefined();
  });

  it('502s when Anthropic is unreachable', async () => {
    modelsList.mockRejectedValue(new Error('network down'));
    mockedAdmin.mockReturnValue(makeAdmin({ key: null }));
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH', { anthropic_api_key: 'sk-ant-api03-fine-key-0000' }), res);
    expect(statusCode()).toBe(502);
  });

  it('null removes the stored key', async () => {
    const state: AdminState = { key: 'sk-ant-api03-old-key-1234' };
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('PATCH', { anthropic_api_key: null }), res);
    expect(statusCode()).toBe(200);
    expect(state.deleted).toBe(true);
    expect(body()).toMatchObject({ ok: true, hasAnthropicKey: false });
  });
});

describe('PATCH /api/profile — existing profile fields', () => {
  it('still updates display_name without touching keys or Anthropic', async () => {
    const state: AdminState = { key: null };
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH', { display_name: 'Alex' }), res);
    expect(statusCode()).toBe(200);
    expect(state.profileUpdate).toMatchObject({ display_name: 'Alex' });
    expect(modelsList).not.toHaveBeenCalled();
    expect(state.upserted).toBeUndefined();
  });

  it('400s an empty body', async () => {
    mockedAdmin.mockReturnValue(makeAdmin({ key: null }));
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH', {}), res);
    expect(statusCode()).toBe(400);
  });
});

describe('PATCH /api/profile — coach fields', () => {
  it('accepts and trims coach_goal and coach_context', async () => {
    const state: AdminState = { key: null };
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH', {
      coach_goal: '  Run a sub-3-hour marathon  ',
      coach_context: '  I am 54 with a history of lower back pain ',
    }), res);
    expect(statusCode()).toBe(200);
    expect(state.profileUpdate).toMatchObject({
      coach_goal: 'Run a sub-3-hour marathon',
      coach_context: 'I am 54 with a history of lower back pain',
    });
  });

  it('accepts empty strings — clearing a field is a valid edit', async () => {
    const state: AdminState = { key: null };
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH', { coach_goal: '', coach_context: '' }), res);
    expect(statusCode()).toBe(200);
    expect(state.profileUpdate).toMatchObject({ coach_goal: '', coach_context: '' });
  });

  it('400s an over-length coach_goal', async () => {
    mockedAdmin.mockReturnValue(makeAdmin({ key: null }));
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('PATCH', { coach_goal: 'x'.repeat(201) }), res);
    expect(statusCode()).toBe(400);
    expect(body()).toBe('Invalid coach_goal');
  });

  it('400s an over-length coach_context', async () => {
    mockedAdmin.mockReturnValue(makeAdmin({ key: null }));
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('PATCH', { coach_context: 'x'.repeat(1001) }), res);
    expect(statusCode()).toBe(400);
    expect(body()).toBe('Invalid coach_context');
  });

  it('400s non-string coach fields', async () => {
    mockedAdmin.mockReturnValue(makeAdmin({ key: null }));
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH', { coach_goal: 42 }), res);
    expect(statusCode()).toBe(400);
  });
});
