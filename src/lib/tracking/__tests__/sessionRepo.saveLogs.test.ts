import { afterEach, describe, expect, it, vi } from 'vitest';

// saveLogs only throws: whether a failure toasts is the save queue's call
// (useWorkoutSession's autosaveFailureToast), never the transport's.

const notify = vi.hoisted(() => vi.fn());
vi.mock('../../notify', () => ({ notify }));
vi.mock('../../supabaseClient', () => ({ supabase: {} }));
vi.mock('../../api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api')>()),
  authHeaders: async () => ({}),
}));

const { saveLogs, AutosaveError } = await import('../sessionRepo');

const payload = { setLogs: [], cardioLogs: [], removedSets: [] };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  notify.mockClear();
});

describe('saveLogs failures', () => {
  it.each([
    ['a dead socket', () => Promise.reject(new TypeError('Failed to fetch')), null],
    ['a 500', () => Promise.resolve(new Response('boom', { status: 500 })), 500],
    ['a 422', () => Promise.resolve(new Response('bad row', { status: 422 })), 422],
    ['a 401', () => Promise.resolve(new Response('', { status: 401 })), 401],
  ])('throws on %s without toasting', async (_label, fetchImpl, status) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
    const err = await saveLogs('e1', '2026-10-16', payload).catch(e => e);
    expect(err).toBeInstanceOf(AutosaveError);
    expect(err.status).toBe(status);
    expect(notify).not.toHaveBeenCalled();
  });
});
