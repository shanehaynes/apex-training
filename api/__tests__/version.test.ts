import { describe, it, expect, afterEach, beforeEach } from 'vitest';
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

// The health booleans read the real environment, and this machine's (or a
// runner's) may have either set. Saved and restored rather than merely
// deleted: vitest shares a process across the files in a worker.
const HEALTH_KEYS = ['VITE_PUBLIC_ORIGIN', 'API_KEY_ENCRYPTION_SECRET'] as const;
const saved: Partial<Record<(typeof HEALTH_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of HEALTH_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  for (const key of HEALTH_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('/api/version', () => {
  it('reports the SHA Vercel stamped on the build', () => {
    process.env.VERCEL_GIT_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
    const { res, statusCode, body } = makeRes();
    handler(makeReq('GET'), res);
    expect(statusCode()).toBe(200);
    expect(body()).toMatchObject({ sha: '0123456789abcdef0123456789abcdef01234567' });
  });

  it('falls back to "dev" when the SHA is unset or empty', () => {
    process.env.VERCEL_GIT_COMMIT_SHA = '';
    const { res, statusCode, body } = makeRes();
    handler(makeReq('GET'), res);
    expect(statusCode()).toBe(200);
    expect(body()).toMatchObject({ sha: 'dev' });
  });

  it('rejects non-GET methods', () => {
    const { res, statusCode } = makeRes();
    handler(makeReq('POST'), res);
    expect(statusCode()).toBe(405);
  });
});

// The health booleans (issue #224). VITE_PUBLIC_ORIGIN and
// API_KEY_ENCRYPTION_SECRET both fail soft — the first falls back to the
// request host, the second stores users' Anthropic keys in plaintext — so
// from outside a deployment there was no way to tell a configured production
// from a misconfigured one. These are what scripts/deploy-verify.sh asserts.
describe('/api/version health booleans', () => {
  const flags = () => {
    const { res, body } = makeRes();
    handler(makeReq('GET'), res);
    return body() as { publicOrigin: boolean; keyEncryption: boolean };
  };

  it('is false for both when neither is configured', () => {
    expect(flags()).toMatchObject({ publicOrigin: false, keyEncryption: false });
  });

  it('is true for each when it is configured', () => {
    process.env.VITE_PUBLIC_ORIGIN = 'https://apextrainingcalendar.vercel.app';
    process.env.API_KEY_ENCRYPTION_SECRET = 'x'.repeat(32);
    expect(flags()).toMatchObject({ publicOrigin: true, keyEncryption: true });
  });

  // A value the code will not actually use must not read as configured:
  // publicOrigin() falls back to the request host for either of these, so
  // reporting true would be a green light on a deployment that still mints
  // per-build URLs into connectors' registrations.
  it.each(['not-a-url', 'ftp://apex.example.com', ''])(
    'reports publicOrigin false for %j, which publicOrigin() would not use',
    raw => {
      process.env.VITE_PUBLIC_ORIGIN = raw;
      expect(flags().publicOrigin).toBe(false);
    },
  );

  // keyCrypto.ts refuses a secret shorter than 16 chars and stores plaintext;
  // the boolean has to agree with the code that does the encrypting, not with
  // "the variable is non-empty".
  it('reports keyEncryption false for a secret too short to be used', () => {
    process.env.API_KEY_ENCRYPTION_SECRET = 'short';
    expect(flags().keyEncryption).toBe(false);
  });

  it('never publishes the values themselves', () => {
    process.env.VITE_PUBLIC_ORIGIN = 'https://apex.example.com';
    process.env.API_KEY_ENCRYPTION_SECRET = 'super-secret-passphrase-value';
    const { res, body } = makeRes();
    handler(makeReq('GET'), res);
    const serialized = JSON.stringify(body());
    expect(serialized).not.toContain('apex.example.com');
    expect(serialized).not.toContain('super-secret');
  });
});
