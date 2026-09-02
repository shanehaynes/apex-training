import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/profile';
import { keyLast4 } from '../_lib/anthropicKey';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';

const { modelsList } = vi.hoisted(() => ({ modelsList: vi.fn() }));

vi.mock('../_lib/supabaseAdmin.js', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('../_lib/auth.js', () => ({ requireUser: vi.fn(async () => 'user-123') }));
vi.mock('../_lib/rateLimit.js', () => ({ enforceRateLimit: vi.fn(async () => true) }));
vi.mock('@anthropic-ai/sdk', () => {
  class AuthenticationError extends Error {}
  class PermissionDeniedError extends Error {}
  // Mirrors the real (status, body, message, headers) signature: the handler
  // reads the body's error.message to say what Anthropic actually objected to.
  class BadRequestError extends Error {
    status: number;
    error: unknown;
    constructor(status: number, error: unknown, message?: string) {
      super(message ?? 'bad request');
      this.status = status;
      this.error = error;
    }
  }
  class MockAnthropic {
    static AuthenticationError = AuthenticationError;
    static PermissionDeniedError = PermissionDeniedError;
    static BadRequestError = BadRequestError;
    models = { list: modelsList };
  }
  return { default: MockAnthropic };
});

const mockedAdmin = vi.mocked(getSupabaseAdmin);

interface AdminState {
  key: string | null;
  /** Latest terms_acceptances row; null (the default) = never accepted. */
  acceptance?: Record<string, unknown> | null;
  upserted?: Record<string, unknown>;
  deleted?: boolean;
  profileUpdate?: Record<string, unknown>;
}

// Minimal chainable fake covering exactly the query shapes profile.ts uses.
function makeAdmin(state: AdminState) {
  return {
    from(table: string) {
      // GET also reads the terms ledger, whose query adds .order().limit()
      // before .maybeSingle().
      const rowFor = (t: string) =>
        t === 'terms_acceptances'
          ? state.acceptance ?? null
          : (state.key ? { anthropic_api_key: state.key } : null);
      return {
        select: () => {
          const leaf: Record<string, unknown> = {};
          leaf.maybeSingle = async () => ({ data: rowFor(table), error: null });
          leaf.order = () => leaf;
          leaf.limit = () => leaf;
          return { eq: () => leaf };
        },
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
  // Most tests exercise the no-secret (plaintext, pre-encryption) path;
  // the at-rest-encryption describe below sets its own.
  delete process.env.API_KEY_ENCRYPTION_SECRET;
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
    // GET also reports the acceptance state — the one call a terms-gated
    // user can still make, and so the only way the client learns the modal
    // is due (see loadKeyStatus in AuthContext.tsx).
    expect(body()).toEqual({
      hasAnthropicKey: false, anthropicKeyLast4: null, termsAccepted: null, termsCurrent: false,
    });
  });

  it('reports masked last-4 when a key is stored — never the key itself', async () => {
    mockedAdmin.mockReturnValue(makeAdmin({ key: 'sk-ant-api03-secret-tail' }));
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('GET'), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({
      hasAnthropicKey: true, anthropicKeyLast4: 'tail', termsAccepted: null, termsCurrent: false,
    });
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
    modelsList.mockRejectedValue(new Anthropic.AuthenticationError(401, undefined, 'bad', new Headers()));
    const state: AdminState = { key: null };
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('PATCH', { anthropic_api_key: 'sk-ant-api03-revoked-key-0000' }), res);
    expect(statusCode()).toBe(400);
    expect(String(body())).toContain('rejected');
    expect(String(body())).not.toContain('revoked-key');
    expect(state.upserted).toBeUndefined();
  });

  it('400s an unscoped key with the Console fix, not a connection error', async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    modelsList.mockRejectedValue(new Anthropic.BadRequestError(400, {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'anthropic-workspace-id is required when authenticating with an identity-linked'
          + ' API key; send the id of the workspace this request acts in.',
      },
    }, 'bad request', new Headers()));
    const state: AdminState = { key: null };
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('PATCH', { anthropic_api_key: 'sk-ant-api03-unscoped-key-0000' }), res);
    expect(statusCode()).toBe(400);
    expect(String(body())).toContain('Workspace');
    expect(state.upserted).toBeUndefined();
  });

  it('passes any other Anthropic 400 through rather than blaming the network', async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    modelsList.mockRejectedValue(new Anthropic.BadRequestError(400, {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Your credit balance is too low.' },
    }, 'bad request', new Headers()));
    mockedAdmin.mockReturnValue(makeAdmin({ key: null }));
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('PATCH', { anthropic_api_key: 'sk-ant-api03-broke-key-0000' }), res);
    expect(statusCode()).toBe(400);
    expect(String(body())).toContain('credit balance');
  });

  it('logs an unreachable check, with any key in the message redacted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // What the header layer throws when a pasted key holds a newline — note
    // that its message quotes the key back, which is why the log redacts.
    modelsList.mockRejectedValue(
      new TypeError('Headers.append: "sk-ant-api03-leaky-key-0000" is an invalid header value.'),
    );
    mockedAdmin.mockReturnValue(makeAdmin({ key: null }));
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH', { anthropic_api_key: 'sk-ant-api03-leaky-key-0000' }), res);
    expect(statusCode()).toBe(502);
    const logged = spy.mock.calls.map(call => call.join(' ')).join('\n');
    expect(logged).toContain('TypeError');
    expect(logged).not.toContain('leaky-key');
    spy.mockRestore();
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

describe('PATCH /api/profile — at-rest key encryption', () => {
  beforeEach(() => {
    process.env.API_KEY_ENCRYPTION_SECRET = 'test-secret-with-plenty-of-entropy';
  });

  it('stores ciphertext, never the raw key, and still masks last4 on read', async () => {
    modelsList.mockResolvedValue({ data: [] });
    const state: AdminState = { key: null };
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode, body } = makeRes();
    const key = 'sk-ant-api03-good-key-value-abcd';
    await handler(makeReq('PATCH', { anthropic_api_key: key }), res);
    expect(statusCode()).toBe(200);
    const stored = state.upserted?.anthropic_api_key as string;
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(stored).not.toContain('sk-ant');
    // last4 comes from the decrypted key, not the ciphertext
    expect(body()).toMatchObject({ hasAnthropicKey: true, anthropicKeyLast4: 'abcd' });
  });

  it('reads a legacy plaintext row transparently', async () => {
    mockedAdmin.mockReturnValue(makeAdmin({ key: 'sk-ant-api03-legacy-key-wxyz' }));
    const { res, statusCode, body } = makeRes();
    await handler(makeReq('GET'), res);
    expect(statusCode()).toBe(200);
    expect(body()).toMatchObject({ hasAnthropicKey: true, anthropicKeyLast4: 'wxyz' });
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

describe('PATCH /api/profile — coach model (phase 38)', () => {
  it('accepts a model id from the catalog', async () => {
    const state: AdminState = { key: null };
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH', { coach_model: 'claude-haiku-4-5-20251001' }), res);
    expect(statusCode()).toBe(200);
    expect(state.profileUpdate).toMatchObject({ coach_model: 'claude-haiku-4-5-20251001' });
  });

  it('accepts null — clearing the pick falls the user back to the app default', async () => {
    const state: AdminState = { key: null };
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH', { coach_model: null }), res);
    expect(statusCode()).toBe(200);
    expect(state.profileUpdate).toMatchObject({ coach_model: null });
  });

  it('400s an id outside the catalog', async () => {
    // The column has no CHECK constraint, so this allowlist is the only
    // thing keeping a junk id out of the row.
    for (const bad of ['gpt-4o', 'claude-opus-4-1', '', 42]) {
      mockedAdmin.mockReturnValue(makeAdmin({ key: null }));
      const { res, statusCode, body } = makeRes();
      await handler(makeReq('PATCH', { coach_model: bad }), res);
      expect(statusCode()).toBe(400);
      expect(body()).toBe('Invalid coach_model');
    }
  });
});

describe('PATCH /api/profile — HR-zone settings (phase 35)', () => {
  it('accepts integer max_hr and threshold_hr', async () => {
    const state: AdminState = { key: null };
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH', { max_hr: 188, threshold_hr: 165 }), res);
    expect(statusCode()).toBe(200);
    expect(state.profileUpdate).toMatchObject({ max_hr: 188, threshold_hr: 165 });
  });

  it('accepts null — clearing a value is a valid edit', async () => {
    const state: AdminState = { key: null };
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH', { threshold_hr: null }), res);
    expect(statusCode()).toBe(200);
    expect(state.profileUpdate).toMatchObject({ threshold_hr: null });
  });

  it('400s out-of-range and non-integer values before the DB constraint would', async () => {
    for (const body of [
      { max_hr: 99 }, { max_hr: 251 }, { max_hr: 180.5 }, { max_hr: '180' },
      { threshold_hr: 79 }, { threshold_hr: 231 },
    ]) {
      const state: AdminState = { key: null };
      mockedAdmin.mockReturnValue(makeAdmin(state));
      const { res, statusCode } = makeRes();
      await handler(makeReq('PATCH', body), res);
      expect(statusCode()).toBe(400);
      expect(state.profileUpdate).toBeUndefined();
    }
  });
});

describe('PATCH /api/profile — onboarding dismissal', () => {
  it('stamps the server clock, never a client-supplied time', async () => {
    const state: AdminState = { key: null };
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const before = Date.now();
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH', { onboarding_dismissed: true }), res);
    expect(statusCode()).toBe(200);

    const stamped = state.profileUpdate?.onboarding_dismissed_at as string;
    expect(Date.parse(stamped)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(stamped)).toBeLessThanOrEqual(Date.now());
  });

  it('rejects a client-supplied timestamp — the field is not client-writable', async () => {
    const state: AdminState = { key: null };
    mockedAdmin.mockReturnValue(makeAdmin(state));
    const { res, statusCode } = makeRes();
    await handler(makeReq('PATCH', { onboarding_dismissed_at: '1999-01-01T00:00:00Z' }), res);
    // Unknown field only: nothing to update, and nothing written.
    expect(statusCode()).toBe(400);
    expect(state.profileUpdate).toBeUndefined();
  });

  it('400s anything but a literal true — the latch is one-way', async () => {
    for (const value of [false, 'true', 1, null]) {
      const state: AdminState = { key: null };
      mockedAdmin.mockReturnValue(makeAdmin(state));
      const { res, statusCode } = makeRes();
      await handler(makeReq('PATCH', { onboarding_dismissed: value }), res);
      expect(statusCode(), `onboarding_dismissed: ${JSON.stringify(value)}`).toBe(400);
      expect(state.profileUpdate).toBeUndefined();
    }
  });
});
