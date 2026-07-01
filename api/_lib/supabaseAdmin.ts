import { createClient } from '@supabase/supabase-js';

// Server-only service-role client — bypasses RLS. Never expose this key to
// the browser (no VITE_ prefix, so Vite never bundles it into client code).
export function getSupabaseAdmin() {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
