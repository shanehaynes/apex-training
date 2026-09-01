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

/** What a submitted key turned out to be, and what to tell the user about it. */
export type KeyCheck =
  | { verdict: 'valid' }
  | { verdict: 'rejected'; message: string }
  | { verdict: 'unreachable' };

// Anthropic's wording for a key that is not tied to one workspace. The fix is
// a Console setting, so passing their message straight through would leave the
// user reading about a request header they have no way to send.
const WORKSPACE_ID_MARKER = 'anthropic-workspace-id';
const WORKSPACE_ID_HELP =
  'That key is not tied to a single workspace, so Anthropic will not accept it here. '
  + 'Create a new key at console.anthropic.com → Settings → API keys with Workspace set '
  + 'to a specific workspace rather than "same as personal account", then paste that one.';

/** The `error.message` Anthropic put in the response body, if it sent one. */
function apiErrorMessage(err: { error?: unknown }): string {
  const body = err.error as { error?: { message?: unknown } } | undefined;
  const message = body?.error?.message;
  return typeof message === 'string' ? message : '';
}

/** Belt and braces for the never-log-the-key rule: no sk-ant- token survives. */
function redactKeys(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-…');
}

/**
 * Check a submitted key against Anthropic before storing it. models.list
 * is free (no tokens); a bad/revoked key answers 401/403.
 *
 * A 400 is neither of those, and is the case worth handling by name: an
 * identity-linked key that is not scoped to a single workspace needs an
 * `anthropic-workspace-id` header on every request, which this app does not
 * send. Identity-linked keys (personal and service-account) are what the
 * Console creates now, and they are exempt from that header only when their
 * creator scopes them to one workspace — so a new user can hit this on their
 * very first key. It used to fall into `unreachable` and tell them to try
 * again in a moment, advice that would never once have worked. Anthropic's
 * own message says what is actually wrong, so surface it.
 */
export async function validateAnthropicKey(key: string): Promise<KeyCheck> {
  try {
    const client = new Anthropic({ apiKey: key });
    await client.models.list({ limit: 1 });
    return { verdict: 'valid' };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return { verdict: 'rejected', message: 'That Anthropic API key was rejected by Anthropic — check it and try again' };
    }
    if (err instanceof Anthropic.BadRequestError) {
      const detail = apiErrorMessage(err);
      if (detail.includes(WORKSPACE_ID_MARKER)) return { verdict: 'rejected', message: WORKSPACE_ID_HELP };
      return {
        verdict: 'rejected',
        message: detail ? `Anthropic rejected that key: ${redactKeys(detail)}` : 'Anthropic rejected that key',
      };
    }

    // A 429, a 5xx, a dead socket, or a TypeError thrown by the header layer
    // when a pasted key holds a character fetch cannot send. Log it: the error
    // carries no key material (and redactKeys makes sure), and without this
    // line the user-facing "try again" is the only trace such a failure leaves
    // anywhere — which is how one of these cost an afternoon to identify.
    const status = (err as { status?: unknown })?.status;
    console.error(
      '[anthropicKey] key check failed:',
      (err as Error)?.constructor?.name ?? typeof err,
      typeof status === 'number' ? status : '',
      redactKeys(String((err as Error)?.message ?? err)),
    );
    return { verdict: 'unreachable' };
  }
}
