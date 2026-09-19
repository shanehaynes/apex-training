import { hasEncryptionSecret } from './keyCrypto.js';
import { configuredPublicOrigin } from './oauth/common.js';

// Which of the deployment's *optional* environment variables are actually
// configured — as booleans, published by GET /api/version.
//
// WHY THIS EXISTS
// VITE_PUBLIC_ORIGIN and API_KEY_ENCRYPTION_SECRET both fail soft on purpose:
// unset, the first falls back to the request's own host and the second stores
// users' Anthropic keys in plaintext with a server-log warning. Both
// fallbacks are right for local dev, e2e and previews, and both are wrong in
// production — and nothing outside the Vercel dashboard could tell which way
// a deployment was configured. The plaintext one is the expensive case: the
// only evidence was one log line at save time, in an hour of retention, on a
// platform with no log drain.
//
// A boolean is the whole point. The values are a secret and a domain; the
// question an external probe (scripts/deploy-verify.sh, an uptime monitor)
// needs answered is only "is it set", and a boolean cannot leak a key length,
// a prefix, or the host the deployment thinks it is.

/** Optional-but-important configuration, as booleans. Never values. */
export interface HealthFlags {
  /** VITE_PUBLIC_ORIGIN is set to a usable http(s) origin (not falling back to the request host). */
  publicOrigin: boolean;
  /** API_KEY_ENCRYPTION_SECRET is set and long enough — stored Anthropic keys are encrypted at rest. */
  keyEncryption: boolean;
}

export function healthFlags(): HealthFlags {
  return {
    publicOrigin: configuredPublicOrigin() !== undefined,
    keyEncryption: hasEncryptionSecret(),
  };
}
