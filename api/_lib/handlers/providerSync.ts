import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';
import {
  beginOAuth,
  connectionStatus,
  disconnect,
  getConnection,
  type SyncProvider,
} from '../providers/connection.js';
import { buildAuthorizeUrl, generatePkce, generateState, isCorosConfigured } from '../providers/coros/oauth.js';

// Fitness-provider sync (phase27): connection lifecycle + the two-phase
// activity grab. Single consolidated route (12-function cap) with
// body.action dispatch (workoutSessions.ts pattern — the dev plugin only
// serves single-segment /api/* paths).
//
//   status        → connection status projection per provider
//   connect-start → mint state + PKCE, park them, return the authorize URL
//   disconnect    → drop the connection row (ledger/streams stay)
//   preview       → fetch new provider activities, propose fills/creates
//   apply         → execute the user's per-activity decisions
//
// The OAuth callback is its own route (/api/provider-callback) because it
// arrives as a browser navigation without a Supabase JWT.

interface Body {
  action?: 'status' | 'connect-start' | 'disconnect' | 'preview' | 'apply';
  provider?: string;
  timezone?: string;
  decisions?: unknown;
}

function parseProvider(value: unknown): SyncProvider | null {
  return value === 'coros' ? 'coros' : null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
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

  const body = (req.body ?? {}) as Body;

  if (body.action === 'status') {
    try {
      const coros = connectionStatus(await getConnection(supabase, userId, 'coros'));
      res.status(200).json({ coros: { ...coros, configured: isCorosConfigured() } });
    } catch (err) {
      console.error('[api/provider-sync] status failed:', err instanceof Error ? err.message : err);
      res.status(500).send('Failed to load connection status');
    }
    return;
  }

  const provider = parseProvider(body.provider);
  if (!provider) {
    res.status(400).send('Unknown provider');
    return;
  }

  if (!(await enforceRateLimit(supabase, res, userId, 'providerSync'))) return;

  try {
    switch (body.action) {
      case 'connect-start': {
        if (!isCorosConfigured()) {
          res.status(503).send('COROS integration is not configured on this deployment');
          return;
        }
        const state = generateState();
        const pkce = generatePkce();
        await beginOAuth(supabase, userId, provider, state, pkce.verifier);
        res.status(200).json({ authorizeUrl: await buildAuthorizeUrl(state, pkce) });
        return;
      }
      case 'disconnect': {
        await disconnect(supabase, userId, provider);
        res.status(200).json({ ok: true });
        return;
      }
      case 'preview':
      case 'apply': {
        const { handleSyncAction } = await import('../providers/sync.js');
        await handleSyncAction(supabase, req, res, userId, provider, body.action);
        return;
      }
      default:
        res.status(400).send('Unknown action');
    }
  } catch (err) {
    console.error(`[api/provider-sync] ${body.action} failed:`, err instanceof Error ? err.message : err);
    res.status(500).send(`Provider ${body.action} failed`);
  }
}
