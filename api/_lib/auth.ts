import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from './supabaseAdmin.js';

// The service-role client bypasses RLS, so verifying the caller's JWT and
// stamping/filtering every query by the verified uid IS the security model
// for /api/*. Never trust a user_id arriving in a request body.

/**
 * Validate the Authorization: Bearer <jwt> header against Supabase Auth.
 * Sends the error response itself and returns null on failure; otherwise
 * returns the authenticated user's id.
 */
export async function requireUser(req: VercelRequest, res: VercelResponse): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return null;
  }

  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!token) {
    res.status(401).send('Missing bearer token');
    return null;
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).send('Invalid or expired token');
    return null;
  }

  return data.user.id;
}
