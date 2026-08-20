import { describe, it, expect, afterEach, vi } from 'vitest';
import { publicOrigin } from '../origin';

// These URLs leave the browser — into Claude's connector config, into a
// calendar app's subscription list, into a password-reset email — so they must
// name the canonical host, not whichever one the user happens to be on.

function onHost(origin: string) {
  vi.stubGlobal('window', { location: { origin } });
}

describe('publicOrigin', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('falls back to the current origin when unset (local dev, e2e)', () => {
    vi.stubEnv('VITE_PUBLIC_ORIGIN', '');
    onHost('http://localhost:5173');
    expect(publicOrigin()).toBe('http://localhost:5173');
  });

  it('pins to the configured origin from a deployment URL', () => {
    vi.stubEnv('VITE_PUBLIC_ORIGIN', 'https://apex.example.com');
    onHost('https://apex-training-abc123-owner.vercel.app');
    expect(publicOrigin()).toBe('https://apex.example.com');
  });

  it('keeps only the origin, dropping any path or trailing slash', () => {
    vi.stubEnv('VITE_PUBLIC_ORIGIN', 'https://apex.example.com/app/');
    onHost('https://apex.example.com');
    expect(publicOrigin()).toBe('https://apex.example.com');
  });

  it('falls back rather than handing out a malformed URL', () => {
    onHost('https://apex.example.com');
    vi.stubEnv('VITE_PUBLIC_ORIGIN', 'not-a-url');
    expect(publicOrigin()).toBe('https://apex.example.com');
    vi.stubEnv('VITE_PUBLIC_ORIGIN', 'ftp://apex.example.com');
    expect(publicOrigin()).toBe('https://apex.example.com');
  });
});
