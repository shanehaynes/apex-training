import Anthropic from '@anthropic-ai/sdk';
import type { getSupabaseAdmin } from './supabaseAdmin.js';
import { decryptSecret, encryptSecret, hasEncryptionSecret, isEncrypted } from './keyCrypto.js';

// Per-user Anthropic API keys, stored in the server-only user_api_keys
// table (RLS enabled, no policies — the service role is the only reader)
// and encrypted at rest when API_KEY_ENCRYPTION_SECRET is set (keyCrypto).
//
// RULE: the raw key leaves this module only via getAnthropicKey, and only
// into the two AI handlers that construct an Anthropic client with it.
// Never log it, never interpolate it into an error message, never include
// it in a response body. Clients see at most keyLast4.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export async function getAnthropicKey(supabase: Admin, userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('user_api_keys')
    .select('anthropic_api_key')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`user_api_keys lookup failed: ${error.message}`);
  const stored = (data?.anthropic_api_key as string | undefined) ?? null;
  if (stored === null) return null;

  if (isEncrypted(stored)) {
    // Throws on a rotated/missing secret — the caller's error path tells
    // the user to re-save the key rather than pretending none exists.
    return decryptSecret(stored);
  }

  // Legacy plaintext row from before the secret was configured: re-encrypt
  // in place on first read. Best-effort — the plaintext is still returned.
  if (hasEncryptionSecret()) {
    const { error: upgradeErr } = await supabase
      .from('user_api_keys')
      .update({ anthropic_api_key: encryptSecret(stored), updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    if (upgradeErr) console.error('[anthropicKey] legacy key re-encrypt failed:', upgradeErr.message);
  }
  return stored;
}

export function keyLast4(key: string): string {
  return key.slice(-4);
}

/**
 * Check a submitted key against Anthropic before storing it. models.list
 * is free (no tokens); a bad/revoked key answers 401/403.
 */
export async function validateAnthropicKey(key: string): Promise<'valid' | 'invalid' | 'unreachable'> {
  try {
    const client = new Anthropic({ apiKey: key });
    await client.models.list({ limit: 1 });
    return 'valid';
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return 'invalid';
    }
    return 'unreachable';
  }
}
