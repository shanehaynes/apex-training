// Fabricated Supabase auth for driving the app without a real login.
//
// The fake JWT never reaches a real project: /auth/v1/* is stubbed entirely
// by the intercept layer, and passthrough REST reads get their Authorization
// header swapped back to the anon key. Shared by the Playwright mock project
// and scripts/drive.mjs.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Parse VITE_SUPABASE_* out of an env file. Both fields are null when the
 * file or the vars are absent — the app then runs offline with no auth gate,
 * and the session seed is skipped.
 */
export function readSupabaseEnv(envFile = '.env.local', root = process.cwd()) {
  try {
    const env = readFileSync(join(root, envFile), 'utf8');
    return {
      ref: env.match(/VITE_SUPABASE_URL=https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ?? null,
      anonKey: env.match(/VITE_SUPABASE_ANON_KEY=(\S+)/)?.[1] ?? null,
    };
  } catch {
    return { ref: null, anonKey: null };
  }
}

export const DRIVER_USER = {
  id: 'driver-user', aud: 'authenticated', role: 'authenticated',
  email: 'driver@example.com', app_metadata: {}, user_metadata: {},
  created_at: '2000-01-01T00:00:00Z',
};

/**
 * Stubbed own-profile row. `fresh: true` nulls template_copied_at so the
 * template-offer banner renders (the auth spec exercises it); everywhere else
 * it is non-null so the banner doesn't float over the bottom calendar rows.
 */
export function driverProfile({ fresh = false } = {}) {
  return {
    id: 'driver-user', display_name: 'Driver', avatar_key: 'goat',
    is_template_source: false,
    template_copied_at: fresh ? null : '2000-01-01T00:00:00Z',
    ics_token: 'driver-ics-token',
    created_at: '2000-01-01T00:00:00Z', updated_at: '2000-01-01T00:00:00Z',
  };
}

export function fabricatedSession() {
  return {
    access_token: 'driver-fake-jwt', token_type: 'bearer',
    expires_in: 36000, expires_at: Math.floor(Date.now() / 1000) + 36000,
    refresh_token: 'driver-fake-refresh', user: DRIVER_USER,
  };
}

/** Seed the fabricated session into localStorage before any page script runs. */
export async function seedFabricatedSession(context, ref) {
  await context.addInitScript(([key, session]) => {
    localStorage.setItem(key, JSON.stringify(session));
  }, [`sb-${ref}-auth-token`, fabricatedSession()]);
}
