import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../_lib/handlers/version';

// The health booleans /api/version publishes alongside the build identity
// (issue #224). Their own file rather than a block in version.test.ts: they
// need the environment saved and restored around every case, which the SHA
// tests do not, and a separate file is also a separate vitest worker, so an
// env var set here cannot reach another file's expectations.
//
// What they are for: VITE_PUBLIC_ORIGIN and API_KEY_ENCRYPTION_SECRET both
// fail SOFT. Unset, the first falls back to the request's own host and the
// second stores users' Anthropic keys in plaintext with one log warning.
// Both fallbacks are right for dev, e2e and previews and wrong in
// production, and nothing outside the Vercel dashboard could tell which way
// a deployment was configured. scripts/deploy-verify.sh asserts these.

function makeRes() {
  let payload: unknown;
  const res = {
    statusCode: 200,
    status(c: number) { res.statusCode = c; return res; },
    send(b: unknown) { payload = b; return res; },
    json(b: unknown) { payload = b; return res; },
  } as unknown as VercelResponse & { statusCode: number };
  return { res, body: () => payload };
}

const GET = { method: 'GET' } as VercelRequest;

// This machine's environment (or a runner's) may have either set. Saved and
// restored, not merely deleted: vitest reuses a process across a worker's files.
const KEYS = ['VITE_PUBLIC_ORIGIN', 'API_KEY_ENCRYPTION_SECRET'] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function flags() {
  const { res, body } = makeRes();
  handler(GET, res);
  return body() as { publicOrigin: boolean; keyEncryption: boolean };
}

describe('/api/version health booleans', () => {
  it('is false for both when neither is configured', () => {
    expect(flags()).toMatchObject({ publicOrigin: false, keyEncryption: false });
  });

  it('is true for each when it is configured', () => {
    process.env.VITE_PUBLIC_ORIGIN = 'https://apextrainingcalendar.vercel.app';
    process.env.API_KEY_ENCRYPTION_SECRET = 'x'.repeat(32);
    expect(flags()).toMatchObject({ publicOrigin: true, keyEncryption: true });
  });

  // A value the code will not actually use must not read as configured:
  // publicOrigin() falls back to the request host for any of these, so
  // reporting true would be a green light on a deployment still minting
  // per-build URLs into connectors' registrations.
  it.each(['not-a-url', 'ftp://apex.example.com', ''])(
    'reports publicOrigin false for %j, which publicOrigin() would not use',
    raw => {
      process.env.VITE_PUBLIC_ORIGIN = raw;
      expect(flags().publicOrigin).toBe(false);
    },
  );

  // keyCrypto.ts refuses a secret shorter than 16 characters and stores
  // plaintext; the boolean has to agree with the code that does the
  // encrypting, not with "the variable is non-empty".
  it('reports keyEncryption false for a secret too short to be used', () => {
    process.env.API_KEY_ENCRYPTION_SECRET = 'short';
    expect(flags().keyEncryption).toBe(false);
  });

  it('never publishes the values themselves', () => {
    process.env.VITE_PUBLIC_ORIGIN = 'https://apex.example.com';
    process.env.API_KEY_ENCRYPTION_SECRET = 'super-secret-passphrase-value';
    const { res, body } = makeRes();
    handler(GET, res);
    const serialized = JSON.stringify(body());
    expect(serialized).not.toContain('apex.example.com');
    expect(serialized).not.toContain('super-secret');
  });
});
