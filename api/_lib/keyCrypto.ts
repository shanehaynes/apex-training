import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// At-rest encryption for stored user secrets (today: Anthropic API keys in
// user_api_keys). RLS-with-no-policies already blocks the anon/authenticated
// path; this layer is for everything RLS can't help with — a DB dump, a
// leaked SUPABASE_SERVICE_ROLE_KEY, backup exfiltration.
//
// AES-256-GCM in the API layer (not pgcrypto) so the encryption secret
// never reaches the database at all. The key is derived from the
// API_KEY_ENCRYPTION_SECRET env var; without it set, values are stored as
// plaintext exactly as before (and profile.ts logs a loud warning), so the
// var can be introduced without a migration: writes start encrypting the
// moment it's set, and getAnthropicKey transparently re-encrypts legacy
// plaintext rows on first read.
//
// Ciphertext format: enc:v1:<iv b64>:<auth tag b64>:<ciphertext b64>.
// Rotating the secret invalidates stored keys (decrypt fails loudly and the
// user re-saves theirs) — acceptable for a low-count personal app; envelope
// keys are overkill here.

const PREFIX = 'enc:v1:';

function encryptionKey(): Buffer | null {
  const secret = process.env.API_KEY_ENCRYPTION_SECRET;
  if (!secret || secret.length < 16) return null;
  // sha256 turns an arbitrary-length passphrase into exactly 32 key bytes.
  return createHash('sha256').update(secret).digest();
}

export function hasEncryptionSecret(): boolean {
  return encryptionKey() !== null;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Throws when API_KEY_ENCRYPTION_SECRET is unset — check hasEncryptionSecret() first. */
export function encryptSecret(plaintext: string): string {
  const key = encryptionKey();
  if (!key) throw new Error('API_KEY_ENCRYPTION_SECRET is not configured');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Decrypt an enc:v1 value. Throws on a missing secret, tampered data, or a
 * secret rotation — callers surface that as "re-save your key", never as a
 * silent null that would read like "no key configured".
 */
export function decryptSecret(value: string): string {
  const key = encryptionKey();
  if (!key) throw new Error('API_KEY_ENCRYPTION_SECRET is not configured but an encrypted value exists');
  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Malformed encrypted value');
  const [iv, tag, ciphertext] = parts.map(p => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
