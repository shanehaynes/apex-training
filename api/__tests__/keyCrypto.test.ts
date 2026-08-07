import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encryptSecret, decryptSecret, isEncrypted, hasEncryptionSecret } from '../_lib/keyCrypto';

const ORIGINAL = process.env.API_KEY_ENCRYPTION_SECRET;

beforeEach(() => {
  process.env.API_KEY_ENCRYPTION_SECRET = 'test-secret-with-plenty-of-entropy';
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.API_KEY_ENCRYPTION_SECRET;
  else process.env.API_KEY_ENCRYPTION_SECRET = ORIGINAL;
});

describe('keyCrypto', () => {
  it('round-trips a key and never stores it recognizably', () => {
    const key = 'sk-ant-api03-abcdefghij';
    const stored = encryptSecret(key);
    expect(isEncrypted(stored)).toBe(true);
    expect(stored).not.toContain('sk-ant');
    expect(decryptSecret(stored)).toBe(key);
  });

  it('uses a fresh IV per encryption (same input, different ciphertext)', () => {
    expect(encryptSecret('sk-ant-x')).not.toBe(encryptSecret('sk-ant-x'));
  });

  it('throws on tampered ciphertext (GCM auth)', () => {
    const stored = encryptSecret('sk-ant-x');
    const parts = stored.split(':');
    const last = parts[parts.length - 1];
    parts[parts.length - 1] = last.slice(0, -4) + (last.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });

  it('throws on a rotated secret rather than returning garbage', () => {
    const stored = encryptSecret('sk-ant-x');
    process.env.API_KEY_ENCRYPTION_SECRET = 'a-completely-different-secret!!';
    expect(() => decryptSecret(stored)).toThrow();
  });

  it('throws on malformed input', () => {
    expect(() => decryptSecret('enc:v1:not-enough-parts')).toThrow();
  });

  it('reports no secret when unset or too short', () => {
    delete process.env.API_KEY_ENCRYPTION_SECRET;
    expect(hasEncryptionSecret()).toBe(false);
    process.env.API_KEY_ENCRYPTION_SECRET = 'short';
    expect(hasEncryptionSecret()).toBe(false);
    expect(() => encryptSecret('sk-ant-x')).toThrow();
  });

  it('legacy plaintext is recognized as not encrypted', () => {
    expect(isEncrypted('sk-ant-api03-plaintext')).toBe(false);
  });
});
