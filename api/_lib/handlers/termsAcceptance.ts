import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';
import { latestAcceptance, isCurrent, recordAcceptance } from '../legal.js';
import { PRIVACY_VERSION, TERMS_VERSION } from '../../../src/lib/legal/versions.js';

// Record and read terms acceptances. Exempt from the gate in requireUser for
// the obvious reason: accepting is how a blocked user stops being blocked.
//
// POST takes NO body. The versions accepted are the server's own constants,
// so there is nothing for a caller to supply and nothing to validate — a
// request body naming a version would be a client asserting what it agreed
// to, which is exactly the assertion this table exists to replace.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const userId = await requireUser(req, res, { skipTermsGate: true });
  if (!userId) return;

  if (req.method === 'GET') {
    try {
      const accepted = await latestAcceptance(supabase, userId);
      res.status(200).json({
        accepted,
        current: isCurrent(accepted),
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION,
      });
    } catch (err) {
      console.error('[api/terms-acceptance] read failed:', err instanceof Error ? err.message : err);
      res.status(500).send('Failed to load acceptance');
    }
    return;
  }

  if (!(await enforceRateLimit(supabase, res, userId, 'writes'))) return;

  try {
    // Unconditional insert, even if the current versions are already
    // accepted. A duplicate row is a harmless extra entry in an audit log;
    // suppressing it would mean the ledger silently disagrees with what the
    // user actually clicked.
    const accepted = await recordAcceptance(supabase, userId, req);
    res.status(200).json({ accepted, current: true });
  } catch (err) {
    console.error('[api/terms-acceptance] insert failed:', err instanceof Error ? err.message : err);
    res.status(500).send('Failed to record acceptance');
  }
}
