import { describe, it, expect, afterEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/version';

function makeRes() {
  let payload: unknown;
  const res = {
    statusCode: 200,
    status(c: number) { res.statusCode = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
  } as unknown as VercelResponse & { statusCode: number };
  return { res, statusCode: () => res.statusCode, body: () => payload };
}

const makeReq = (method: string) => ({ method } as VercelRequest);

afterEach(() => {
  delete process.env.VERCEL_GIT_COMMIT_SHA;
});

describe('/api/version', () => {
  it('reports the SHA Vercel stamped on the build', () => {
    process.env.VERCEL_GIT_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
    const { res, statusCode, body } = makeRes();
    handler(makeReq('GET'), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ sha: '0123456789abcdef0123456789abcdef01234567' });
  });

  it('falls back to "dev" when the SHA is unset or empty', () => {
    process.env.VERCEL_GIT_COMMIT_SHA = '';
    const { res, statusCode, body } = makeRes();
    handler(makeReq('GET'), res);
    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ sha: 'dev' });
  });

  it('rejects non-GET methods', () => {
    const { res, statusCode } = makeRes();
    handler(makeReq('POST'), res);
    expect(statusCode()).toBe(405);
  });
});
