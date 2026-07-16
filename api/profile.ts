import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';
import { requireUser } from './_lib/auth.js';
import { getAnthropicKey, keyLast4, validateAnthropicKey } from './_lib/anthropicKey.js';

// Profile reads/writes, same posture as every other table: the browser
// reads profiles via RLS (own row only) and mutates through this
// service-role endpoint. Strict allowlist — is_template_source,
// template_copied_at, and ics_token are never client-writable.
//
// Also owns the user's Anthropic API key (server-only user_api_keys
// table): PATCH { anthropic_api_key } saves/replaces/removes it, GET
// reports { hasAnthropicKey, anthropicKeyLast4 }. The raw key is never
// logged and never echoed back in any response.

const AVATAR_KEYS = [
  'goat', 'ibex', 'snow-leopard', 'eagle', 'wolf',
  'bighorn', 'marmot', 'raven', 'lynx', 'fox',
  'bear', 'owl', 'falcon', 'pika', 'elk',
  'wolverine', 'cougar', 'chamois', 'yak', 'hare',
  'orca', 'seal', 'otter', 'octopus',
];

async function keyStatus(supabase: NonNullable<ReturnType<typeof getSupabaseAdmin>>, userId: string) {
  const key = await getAnthropicKey(supabase, userId);
  return { hasAnthropicKey: key !== null, anthropicKeyLast4: key ? keyLast4(key) : null };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'PATCH') {
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

  if (req.method === 'GET') {
    try {
      res.status(200).json(await keyStatus(supabase, userId));
    } catch (err) {
      console.error('[api/profile] key status failed:', err instanceof Error ? err.message : err);
      res.status(500).send('Failed to load key status');
    }
    return;
  }

  const body = req.body as {
    display_name?: unknown;
    avatar_key?: unknown;
    anthropic_api_key?: unknown;
  } | undefined;

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

  const hasKeyChange = body !== undefined && 'anthropic_api_key' in body;
  if (Object.keys(fields).length === 0 && !hasKeyChange) {
    res.status(400).send('No updatable fields');
    return;
  }

  if (hasKeyChange) {
    if (body!.anthropic_api_key === null) {
      const { error } = await supabase.from('user_api_keys').delete().eq('user_id', userId);
      if (error) {
        console.error('[api/profile] key delete failed:', error.message);
        res.status(500).send('Failed to remove API key');
        return;
      }
    } else {
      const raw = body!.anthropic_api_key;
      const key = typeof raw === 'string' ? raw.trim() : '';
      if (!key.startsWith('sk-ant-') || key.length < 20 || key.length > 300) {
        res.status(400).send('Invalid Anthropic API key format — keys start with sk-ant-');
        return;
      }

      const verdict = await validateAnthropicKey(key);
      if (verdict === 'invalid') {
        res.status(400).send('That Anthropic API key was rejected by Anthropic — check it and try again');
        return;
      }
      if (verdict === 'unreachable') {
        res.status(502).send("Couldn't verify the key with Anthropic — try again in a moment");
        return;
      }

      const { error } = await supabase
        .from('user_api_keys')
        .upsert(
          { user_id: userId, anthropic_api_key: key, updated_at: new Date().toISOString() },
          { onConflict: 'user_id' },
        );
      if (error) {
        console.error('[api/profile] key upsert failed:', error.message);
        res.status(500).send('Failed to save API key');
        return;
      }
    }
  }

  if (Object.keys(fields).length > 0) {
    const { error } = await supabase
      .from('profiles')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', userId);
    if (error) {
      console.error('[api/profile] update failed:', error.message);
      res.status(500).send('Failed to update profile');
      return;
    }
  }

  try {
    res.status(200).json({ ok: true, ...(await keyStatus(supabase, userId)) });
  } catch {
    // Write succeeded; only the status readback failed. Don't fail the PATCH.
    res.status(200).json({ ok: true });
  }
}
