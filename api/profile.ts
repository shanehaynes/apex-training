import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';
import { requireUser } from './_lib/auth.js';

// Profile writes, same posture as every other table: the browser reads
// profiles via RLS (own row only) and mutates through this service-role
// endpoint. Strict allowlist — is_template_source, template_copied_at, and
// ics_token are never client-writable.

const AVATAR_KEYS = ['goat', 'ibex', 'snow-leopard', 'eagle', 'wolf'];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'PATCH') {
    res.status(405).send('Method not allowed');
    return;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const userId = await requireUser(req, res);
  if (!userId) return;

  const body = req.body as { display_name?: unknown; avatar_key?: unknown } | undefined;
  const fields: Record<string, string> = {};

  if (body?.display_name !== undefined) {
    if (typeof body.display_name !== 'string' || !body.display_name.trim() || body.display_name.length > 80) {
      res.status(400).send('Invalid display_name');
      return;
    }
    fields.display_name = body.display_name.trim();
  }

  if (body?.avatar_key !== undefined) {
    if (typeof body.avatar_key !== 'string' || !AVATAR_KEYS.includes(body.avatar_key)) {
      res.status(400).send('Invalid avatar_key');
      return;
    }
    fields.avatar_key = body.avatar_key;
  }

  if (Object.keys(fields).length === 0) {
    res.status(400).send('No updatable fields');
    return;
  }

  const { error } = await supabase
    .from('profiles')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', userId);
  if (error) {
    console.error('[api/profile] update failed:', error.message);
    res.status(500).send('Failed to update profile');
    return;
  }

  res.status(200).json({ ok: true });
}
