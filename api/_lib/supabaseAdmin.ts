import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../src/lib/db/database.types.js';

// Server-only service-role client — bypasses RLS. Never expose this key to
// the browser (no VITE_ prefix, so Vite never bundles it into client code).

// Reused across calls within a warm invocation: a single request builds one
// in requireUser and at least one more in the handler, across ~25 call sites.
// Keyed on the env values rather than built once, because the env is still
// read at call time — the integration tests swap credentials between requests
// and must get a client pointed at the new project, not the cached one.
let cached: { url: string; key: string; client: SupabaseClient<Database> } | null = null;

export function getSupabaseAdmin() {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  if (cached && cached.url === url && cached.key === key) return cached.client;

  // autoRefreshToken defaults on, which starts a refresh ticker on a client
  // that never holds a session — pure overhead on a service-role client.
  const client = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  cached = { url, key, client };
  return client;
}
