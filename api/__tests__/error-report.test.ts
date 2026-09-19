import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reportError } from '../_lib/errorReport';

// The seam every unhandled /api/* error passes through (api/_lib/app.ts).
// What is pinned here is what makes it safe to leave in the request path:
// it never throws, it never blocks on a webhook that is down, and it never
// reports anything but the error itself.

const ORIGINAL_WEBHOOK = process.env.APEX_ERROR_WEBHOOK_URL;

beforeEach(() => {
  delete process.env.APEX_ERROR_WEBHOOK_URL;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_WEBHOOK === undefined) delete process.env.APEX_ERROR_WEBHOOK_URL;
  else process.env.APEX_ERROR_WEBHOOK_URL = ORIGINAL_WEBHOOK;
});

/** The `[apex/error] {...}` line, parsed. */
function loggedEvent(): Record<string, unknown> {
  const call = vi.mocked(console.error).mock.calls.find(c => String(c[0]).startsWith('[apex/error] '));
  expect(call, 'no [apex/error] line was logged').toBeDefined();
  return JSON.parse(String(call![0]).slice('[apex/error] '.length));
}

describe('reportError', () => {
  it('logs one parseable line with a stable tag', async () => {
    await reportError(new TypeError('boom'), { route: '/api/events', method: 'POST' });
    const event = loggedEvent();
    expect(event).toMatchObject({
      tag: 'APEX-API-ERROR',
      route: '/api/events',
      method: 'POST',
      name: 'TypeError',
      message: 'boom',
    });
    expect(typeof event.at).toBe('string');
  });

  // The stack is its own call so the JSON stays on one line; a log search
  // that splits on newlines still gets a whole event.
  it('logs the stack separately from the JSON line', async () => {
    await reportError(new Error('boom'), { route: '/api/profile' });
    const lines = vi.mocked(console.error).mock.calls.map(c => String(c[0]));
    expect(lines.filter(l => l.startsWith('[apex/error] '))).toHaveLength(1);
    expect(lines.some(l => l.includes('Error: boom') && l.includes('at '))).toBe(true);
  });

  it('survives a thrown non-Error', async () => {
    await expect(reportError('just a string', { route: '/api/query' })).resolves.toBeUndefined();
    expect(loggedEvent()).toMatchObject({ name: 'string', message: 'just a string' });
  });

  it('posts the event when a webhook is configured', async () => {
    process.env.APEX_ERROR_WEBHOOK_URL = 'https://errors.example.com/hook';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await reportError(new Error('boom'), { route: '/api/meals', method: 'GET' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://errors.example.com/hook');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      tag: 'APEX-API-ERROR',
      route: '/api/meals',
      message: 'boom',
    });
    // A hung webhook must not hold a serverless invocation open.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not post when no webhook is configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    await reportError(new Error('boom'), { route: '/api/meals' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The whole point of the seam is that it cannot make a bad request worse.
  it('resolves, and still logs, when the webhook itself fails', async () => {
    process.env.APEX_ERROR_WEBHOOK_URL = 'https://errors.example.com/hook';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(reportError(new Error('boom'), { route: '/api/account' })).resolves.toBeUndefined();
    expect(loggedEvent()).toMatchObject({ route: '/api/account' });
    // One entry for the real error, not a second for the webhook's failure.
    const lines = vi.mocked(console.error).mock.calls.map(c => String(c[0]));
    expect(lines.filter(l => l.startsWith('[apex/error] '))).toHaveLength(1);
  });
});
