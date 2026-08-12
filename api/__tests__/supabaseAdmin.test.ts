import { describe, it, expect, afterEach } from 'vitest';
import { getSupabaseAdmin } from '../_lib/supabaseAdmin';

// The client is reused across calls, but the env is still read every call.
// Both halves matter: the reuse is the point, and the re-read is what the
// integration tests rely on when they swap credentials between requests.

const URL_A = 'http://127.0.0.1:54321';
const URL_B = 'http://127.0.0.1:54331';
const KEY_A = 'service-role-key-a';
const KEY_B = 'service-role-key-b';

const original = {
  url: process.env.VITE_SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

function setEnv(url: string | undefined, key: string | undefined) {
  if (url === undefined) delete process.env.VITE_SUPABASE_URL;
  else process.env.VITE_SUPABASE_URL = url;
  if (key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = key;
}

afterEach(() => setEnv(original.url, original.key));

describe('getSupabaseAdmin', () => {
  it('returns null when either credential is missing', () => {
    setEnv(undefined, KEY_A);
    expect(getSupabaseAdmin()).toBeNull();
    setEnv(URL_A, undefined);
    expect(getSupabaseAdmin()).toBeNull();
  });

  it('reuses one client across calls with unchanged credentials', () => {
    setEnv(URL_A, KEY_A);
    expect(getSupabaseAdmin()).toBe(getSupabaseAdmin());
  });

  it('builds a new client when the url changes', () => {
    setEnv(URL_A, KEY_A);
    const first = getSupabaseAdmin();
    setEnv(URL_B, KEY_A);
    expect(getSupabaseAdmin()).not.toBe(first);
  });

  it('builds a new client when the key changes', () => {
    setEnv(URL_A, KEY_A);
    const first = getSupabaseAdmin();
    setEnv(URL_A, KEY_B);
    expect(getSupabaseAdmin()).not.toBe(first);
  });

  it('does not resurrect a cached client after the env is cleared', () => {
    setEnv(URL_A, KEY_A);
    expect(getSupabaseAdmin()).not.toBeNull();
    setEnv(undefined, undefined);
    expect(getSupabaseAdmin()).toBeNull();
  });
});
