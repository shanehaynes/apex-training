// Cloudflare Turnstile's public site key. Set = the web's Create account tab
// is open and goes through /api/signup; unset = invite-only (DEPLOY_MULTI_USER.md §6).
//
// Dev builds also read window.__APEX_TURNSTILE_SITE_KEY__, so a mock e2e spec
// can open the form without rebuilding with the env var
// (e2e/mock/open-signup.spec.ts). import.meta.env.DEV is false in production,
// so the bundle Vercel serves never reads it.
export function turnstileSiteKey(): string | undefined {
  const fromEnv = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) || undefined;
  if (fromEnv || !import.meta.env.DEV || typeof window === 'undefined') return fromEnv;
  return (window as { __APEX_TURNSTILE_SITE_KEY__?: string }).__APEX_TURNSTILE_SITE_KEY__ || undefined;
}
