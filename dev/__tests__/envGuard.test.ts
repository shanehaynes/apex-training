import { describe, it, expect, vi, afterEach } from 'vitest';
import { assertProdEnv, checkProdEnv, REQUIRED_PROD_VARS } from '../envGuard.mjs';

// On 2026-09-01 a production deploy shipped with VITE_SUPABASE_URL and
// VITE_SUPABASE_ANON_KEY missing. Nothing failed: the bundle booted into
// offline seed mode and served a read-only demo of stale data, with no error
// page and no failed deploy — just a console.warn. These tests pin the two
// halves of the fix that are easy to get backwards: it must fail the real
// production build, and it must NOT fail CI, which builds with no Supabase
// vars on every push and would otherwise go permanently red.

const PROD = { VERCEL_ENV: 'production' };
const FULL = { ...PROD, VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_ANON_KEY: 'eyJ.a.b', VITE_PUBLIC_ORIGIN: 'https://apex.example' };

afterEach(() => vi.restoreAllMocks());

describe('checkProdEnv', () => {
  it('names every missing required var on a Vercel production build', () => {
    expect(checkProdEnv({ env: PROD }).missing).toEqual(REQUIRED_PROD_VARS);
  });

  it('passes when production has both Supabase vars', () => {
    expect(checkProdEnv({ env: FULL })).toEqual({ missing: [], warnings: [] });
  });

  it('treats blank and whitespace-only as missing — an empty Vercel field is not a value', () => {
    const env = { ...FULL, VITE_SUPABASE_ANON_KEY: '   ' };
    expect(checkProdEnv({ env }).missing).toEqual(['VITE_SUPABASE_ANON_KEY']);
  });

  // CI runs `npm run build` with no Supabase vars to prove the bundle
  // compiles. VERCEL_ENV is set by Vercel's builders alone, so keying on it
  // is what keeps that job green.
  it('stays silent off Vercel, however empty the environment', () => {
    expect(checkProdEnv({ env: {} })).toEqual({ missing: [], warnings: [] });
  });

  // A preview that failed to build would block the very PR that fixes the
  // config, so previews warn through the app instead of failing the deploy.
  it('exempts preview and development builds', () => {
    expect(checkProdEnv({ env: { VERCEL_ENV: 'preview' } }).missing).toEqual([]);
    expect(checkProdEnv({ env: { VERCEL_ENV: 'development' } }).missing).toEqual([]);
  });

  it('ignores the dev server — only a build is a deployment', () => {
    expect(checkProdEnv({ command: 'serve', env: PROD }).missing).toEqual([]);
  });

  it('warns without failing when VITE_PUBLIC_ORIGIN is absent', () => {
    const { missing, warnings } = checkProdEnv({ env: { ...FULL, VITE_PUBLIC_ORIGIN: '' } });
    expect(missing).toEqual([]);
    expect(warnings).toEqual(['VITE_PUBLIC_ORIGIN']);
  });
});

describe('assertProdEnv', () => {
  it('throws, naming both vars and how to set them', () => {
    expect(() => assertProdEnv({ env: PROD })).toThrow(/VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY/);
    expect(() => assertProdEnv({ env: PROD })).toThrow(/Config,\s*\n?\s*not Secret/);
  });

  it('does not throw for a missing warn-only var, but says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => assertProdEnv({ env: { ...FULL, VITE_PUBLIC_ORIGIN: undefined } })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('VITE_PUBLIC_ORIGIN'));
  });

  it('is a no-op for CI, which is the case that must never break', () => {
    expect(() => assertProdEnv({ env: {} })).not.toThrow();
  });
});
