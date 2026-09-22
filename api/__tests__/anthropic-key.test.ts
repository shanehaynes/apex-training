import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateAnthropicKey } from '../_lib/anthropicKey';

// The key check is a real network call (models.list) on a key the user just
// typed, so it goes through the shared client like every other call site.
const { modelsList, clientOptions } = vi.hoisted(() => ({
  modelsList: vi.fn(async () => ({ data: [] })),
  /** Every options object handed to `new Anthropic(...)` — the timeout and
   *  retry budget are as load-bearing as the request params (anthropicClient.ts). */
  clientOptions: [] as Array<Record<string, unknown>>,
}));
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    constructor(options: Record<string, unknown>) { clientOptions.push(options); }
    models = { list: modelsList };
    // The catch block narrows on these SDK error classes; the happy path here
    // never reaches it, but they must exist for the module to evaluate.
    static AuthenticationError = class extends Error {};
    static PermissionDeniedError = class extends Error {};
    static BadRequestError = class extends Error {};
    static APIError = class extends Error {};
  }
  return { default: MockAnthropic };
});

beforeEach(() => {
  clientOptions.length = 0;
  modelsList.mockClear();
});

describe('validateAnthropicKey', () => {
  it('accepts a key that models.list answers', async () => {
    await expect(validateAnthropicKey('sk-ant-test')).resolves.toEqual({ verdict: 'valid' });
    expect(modelsList).toHaveBeenCalledWith({ limit: 1 });
  });

  it('builds the SDK client with a bounded timeout and one retry', async () => {
    await validateAnthropicKey('sk-ant-test');
    // A user is waiting on this one synchronously; 20s per attempt bounds
    // time-to-headers instead of the SDK's ten minutes — api/_lib/anthropicClient.ts.
    expect(clientOptions.at(-1)).toMatchObject({ maxRetries: 1, timeout: 20000 });
  });
});
