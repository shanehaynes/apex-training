// Reads the committed agent-profile env (.env.agent) — the LOCAL Supabase
// stack's URL and keys. Refuses anything that isn't localhost: these scripts
// create users, drop tables, and write rows, and must never be pointable at
// a remote project.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function localSupabaseEnv(root = process.cwd()) {
  const file = join(root, '.env.agent');
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error('.env.agent not found — run `supabase start` and create it first (see AGENTS.md)');
  }
  const get = key => raw.match(new RegExp(`^${key}=(\\S+)`, 'm'))?.[1];
  const url = get('VITE_SUPABASE_URL');
  const anonKey = get('VITE_SUPABASE_ANON_KEY');
  const serviceKey = get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) {
    throw new Error('.env.agent is missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY');
  }
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`refusing non-local Supabase URL in .env.agent: ${url}`);
  }
  return { url, anonKey, serviceKey };
}
