// Cloudflare Turnstile's public site key. Set = the web's Create account tab
// is open and goes through /api/signup; unset = invite-only (DEPLOY_MULTI_USER.md §6).
export const TURNSTILE_SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) || undefined;
