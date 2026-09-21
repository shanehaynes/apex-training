import { describe, it, expect, vi, afterEach } from 'vitest';
import type { VercelResponse } from '@vercel/node';
import { CONSTRAINT_VIOLATION_BODY, isPermanentWriteError, sendWriteFailure } from '../_lib/pgError';

function makeRes() {
  let code: number | null = null;
  let payload: unknown;
  const res = {
    status(c: number) { code = c; return res; },
    send(b: unknown) { payload = b; return res; },
  } as unknown as VercelResponse;
  return { res, statusCode: () => code, body: () => payload };
}

afterEach(() => vi.restoreAllMocks());

describe('isPermanentWriteError', () => {
  it('is true for every class-23 integrity violation', () => {
    // not-null, foreign key, unique, check, exclusion.
    for (const code of ['23502', '23503', '23505', '23514', '23P01']) {
      expect(isPermanentWriteError({ code, message: 'nope' }), code).toBe(true);
    }
  });

  it('is true for every class-22 data exception', () => {
    // string-too-long, numeric out of range, bad datetime, bad text literal.
    for (const code of ['22001', '22003', '22007', '22P02']) {
      expect(isPermanentWriteError({ code, message: 'nope' }), code).toBe(true);
    }
  });

  it('is false for the codes a later attempt may survive', () => {
    // connection, serialization/deadlock, resources, operator intervention,
    // and PostgREST's own non-SQLSTATE codes.
    for (const code of ['08006', '08003', '40001', '40P01', '53300', '57014', 'PGRST116', '42501']) {
      expect(isPermanentWriteError({ code, message: 'nope' }), code).toBe(false);
    }
  });

  it('is false when there is no code to read — unknown is never permanent', () => {
    expect(isPermanentWriteError({ message: 'fetch failed' })).toBe(false);
    expect(isPermanentWriteError({ code: null, message: 'x' })).toBe(false);
    expect(isPermanentWriteError(null)).toBe(false);
    expect(isPermanentWriteError(undefined)).toBe(false);
  });
});

describe('sendWriteFailure', () => {
  it('sends 400 and the stable body for a constraint violation, logging the detail', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { res, statusCode, body } = makeRes();
    sendWriteFailure(res, '[api/x] save', { code: '23505', message: 'duplicate key value' }, 'Failed to save');
    expect(statusCode()).toBe(400);
    expect(body()).toBe(CONSTRAINT_VIOLATION_BODY);
    // The constraint text names columns; it belongs in the log, not the wire.
    expect(logged.mock.calls[0].join(' ')).toContain('duplicate key value');
  });

  it('sends 500 and the caller\'s prose for anything retryable', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { res, statusCode, body } = makeRes();
    sendWriteFailure(res, '[api/x] save', { code: '08006', message: 'connection reset' }, 'Failed to save');
    expect(statusCode()).toBe(500);
    expect(body()).toBe('Failed to save');
  });
});
