// The one place in api/ runtime code that reads process.env. A structural
// test (api/__tests__/env-surface.test.ts) walks api/ to keep it that way, and
// checks this list against .env.example in both directions, so the set of
// variables the API needs is written down exactly once and cannot drift from
// the code that reads them.
//
// Reads are deliberately lazy — a function call per read, never a module-level
// constant. The integration tests swap credentials in process.env between
// requests and must get a client pointed at the new values (supabaseAdmin.ts
// keys its cache on them for the same reason), and the unit tests assign
// process.env after import. Capturing at load time would break both.
//
// An empty value means unset. Vercel's dashboard and the blank placeholders
// in .env.example both produce '', and every call site already treated it as
// missing, so the helpers normalise it once rather than each site re-checking.

/** Every environment variable the API reads, with what it is for and where it is set. */
export const ENV_KEYS = [
  // Supabase project URL; shared with the client bundle. `.env.local` (your
  // project) / `.env.agent` (the local stack) / Vercel project env.
  'VITE_SUPABASE_URL',
  // Service-role key for the admin client; bypasses RLS, never VITE_-prefixed.
  // `.env.local` / `.env.agent` / Vercel project env.
  'SUPABASE_SERVICE_ROLE_KEY',
  // Canonical origin every stored URL is built from (OAuth issuer, MCP and
  // ICS endpoints). Vercel PRODUCTION env only; unset for dev, e2e, previews.
  'VITE_PUBLIC_ORIGIN',
  // At-rest encryption for users' stored Anthropic keys (keyCrypto.ts).
  // `.env.local` / Vercel project env; unset stores plaintext with a warning.
  'API_KEY_ENCRYPTION_SECRET',
  // Account whose recurring workouts seed new users via /api/template-copy.
  // `.env.local` / Vercel project env; falls back to profiles.is_template_source.
  'SEED_SOURCE_USER_ID',
  // Bearer token guarding /api/review-cron and /api/provider-cron. Vercel
  // project env (Vercel sends it on cron runs); locally only to curl a cron.
  'CRON_SECRET',
  // Gmail address review emails are sent from (also the From). Vercel project
  // env; `.env.local` only to test mail delivery.
  'GMAIL_USER',
  // 16-char Gmail app password for that account. Vercel project env;
  // `.env.local` only to test mail delivery.
  'GMAIL_APP_PASSWORD',
  // Public OAuth client id registered with COROS (PKCE, no secret).
  // `.env.local` / Vercel project env; both COROS_* unset = "not configured".
  'COROS_CLIENT_ID',
  // Redirect URI registered with that client, e.g. https://<host>/api/provider-callback.
  // `.env.local` / Vercel project env.
  'COROS_REDIRECT_URI',
  // Commit SHA Vercel stamps on each deployment (system variable, set by
  // Vercel itself, never by hand). /api/version reports it so
  // scripts/deploy-verify.sh can prove which build production serves.
  'VERCEL_GIT_COMMIT_SHA',
] as const;

export type EnvKey = (typeof ENV_KEYS)[number];

/** The variable's value, or undefined when it is unset or empty. */
export function optionalEnv(name: EnvKey): string | undefined {
  const value = process.env[name];
  return value ? value : undefined;
}

/** The variable's value; throws naming the variable when it is unset or empty. */
export function requireEnv(name: EnvKey): string {
  const value = optionalEnv(name);
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
}
