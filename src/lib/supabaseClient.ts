import { createClient } from '@supabase/supabase-js';
import type { Database } from './db/database.types';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Returns null when env vars are missing (dev without .env.local, or missing Vercel config).
// ScheduleContext falls back to localStorage-only mode in this case — loudly,
// so a misconfigured deploy doesn't silently pass for a working offline mode.
if (!url || !key) {
  console.warn('[apex] VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY not set — running in offline seed mode');
}
export const supabase = url && key ? createClient<Database>(url, key) : null;
