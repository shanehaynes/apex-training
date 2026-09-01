// Refuses to build a production deployment that would boot into offline mode.
//
// src/lib/supabaseClient.ts exports `supabase` as null when VITE_SUPABASE_URL
// or VITE_SUPABASE_ANON_KEY is absent, and AuthContext then starts at status
// 'offline'. That is the right behaviour locally — a checkout without
// .env.local still runs off the bundled seed file. In production it is a
// silent outage: no avatar (TopNav gates on 'signedIn'), no login gate either
// (App renders LoginView only on 'signedOut'), and a calendar full of
// plausible-looking seed workouts that are nobody's real data. It shipped
// exactly once, on 2026-09-01, when the Supabase↔Vercel integration was
// disconnected and took both variables with it. The only signal was a
// console.warn, so it stayed up until someone noticed a missing avatar.
//
// Vite inlines VITE_* at build time, which is what makes this catchable
// before a deploy rather than after: if the value is not there when the
// bundle is written, no amount of runtime configuration can rescue it.
//
// Scope is deliberately narrow. CI runs `npm run build` with no Supabase
// vars at all to prove the bundle compiles, and must keep passing — so the
// hard failure keys on VERCEL_ENV, which only Vercel's own builders set.
//
// Plain JS to match port.mjs; envGuard.d.mts gives vite.config.ts its types.

/** Client vars without which the app cannot reach Supabase at all. */
export const REQUIRED_PROD_VARS = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'];

/**
 * Vars whose absence degrades production without breaking it. VITE_PUBLIC_ORIGIN
 * unset means the OAuth issuer, MCP endpoint, ICS feed and password-reset links
 * all follow the request Host, so anything copied out of the app can freeze a
 * deployment URL that sits behind Vercel's SSO wall (see PR #85).
 */
export const EXPECTED_PROD_VARS = ['VITE_PUBLIC_ORIGIN'];

const blank = value => value === undefined || value === null || String(value).trim() === '';

/**
 * @param {{ command?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {{ missing: string[], warnings: string[] }}
 */
export function checkProdEnv(options = {}) {
  const { command = 'build', env = process.env } = options;

  // A dev server or a `vitest` run is never a deployment.
  if (command !== 'build') return { missing: [], warnings: [] };
  // VERCEL_ENV is 'production' | 'preview' | 'development', set by Vercel's
  // builders only. Previews are exempt: they are throwaway hosts, and a
  // preview that failed to build would block the PR that fixes the config.
  if (env.VERCEL_ENV !== 'production') return { missing: [], warnings: [] };

  return {
    missing: REQUIRED_PROD_VARS.filter(name => blank(env[name])),
    warnings: EXPECTED_PROD_VARS.filter(name => blank(env[name])),
  };
}

/** Throws on a production build that would ship without Supabase. */
export function assertProdEnv(options = {}) {
  const { missing, warnings } = checkProdEnv(options);

  for (const name of warnings) {
    console.warn(`[apex] ${name} is not set for this production build — client-facing URLs will follow the request Host.`);
  }

  if (missing.length === 0) return;
  throw new Error(
    `Refusing to build production without ${missing.join(' and ')}.\n` +
    'Vite inlines VITE_* at build time, so the deployed bundle would boot into\n' +
    'offline seed mode: no sign-in, no real data, and no error page saying so.\n' +
    'Set the variables in Vercel → Settings → Environment Variables (type Config,\n' +
    'not Secret — VITE_* values are public by definition) and redeploy.',
  );
}
