import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';
import {
  appleStatus,
  beginOAuth,
  connectionStatus,
  connectLocal,
  disconnect,
  getConnection,
  parseCategories,
  purgeDailyMetrics,
  setAutoSync,
  setCategories,
  type ProviderClient,
  type SyncProvider,
} from '../providers/connection.js';
import { isValidTimezone } from '../userTimezone.js';
import { buildAuthorizeUrl, generatePkce, generateState, isCorosConfigured } from '../providers/coros/oauth.js';
import {
  COROS_DISCONNECT_NOTICE,
  COROS_UPSTREAM_REVOCATION_SUPPORTED,
} from '../../../src/lib/sync/corosRevocation.js';

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
// Apple Health (W16 M2b) has no OAuth: the phone reads Health and posts what
// it read, so its lifecycle is connect / set-categories / disconnect, and
// preview / apply / ingest carry the activities in the body. Consent is
// enforced here and in sync.ts, never trusted to the phone.
//
//   connect        → upsert a connected apple row with its categories
//   set-categories → merge opt-ins; 409 'not-connected' without a row
//   ingest         → unattended: create the unmatched, never fill
//
// The OAuth callback is its own route (/api/provider-callback) because it
// arrives as a browser navigation without a Supabase JWT.

interface Body {
  action?: string;
  provider?: string;
  timezone?: unknown;
  decisions?: unknown;
  enabled?: unknown;
  client?: unknown;
  categories?: unknown;
  purgeMetrics?: unknown;
}

function parseProvider(value: unknown): SyncProvider | null {
  return value === 'coros' || value === 'apple' ? value : null;
}

/** What each provider answers to. COROS keeps its OAuth set; Apple has no
 *  OAuth and no nightly job (the phone syncs), so connect-start and
 *  set-auto-sync are not its actions. */
const PROVIDER_ACTIONS: Record<SyncProvider, ReadonlySet<string>> = {
  coros: new Set(['connect-start', 'disconnect', 'set-auto-sync', 'preview', 'apply']),
  apple: new Set(['connect', 'set-categories', 'disconnect', 'preview', 'apply', 'ingest']),
};

/** Apple's Disconnect: Apex stops reading and drops the row; what was
 *  imported stays, and Health's own permission is the athlete's to revoke. */
export const APPLE_DISCONNECT_NOTICE =
  'Apex no longer reads Apple Health. Workouts already imported stay on your calendar. '
  + 'To remove Apex’s access completely, turn it off in the Health app under Sharing → Apps.';

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
      const [corosRow, appleRow] = await Promise.all([
        getConnection(supabase, userId, 'coros'),
        getConnection(supabase, userId, 'apple'),
      ]);
      res.status(200).json({
        coros: { ...connectionStatus(corosRow), configured: isCorosConfigured() },
        apple: appleStatus(appleRow),
      });
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

  // Which client is driving the OAuth dance (phase41). Validated here, beside
  // the provider and ahead of the rate limit, because both are body-shape
  // checks: a malformed body should not spend the caller's budget. Absent is
  // the web, the only value stored is 'ios', and an unknown one never reaches
  // the database — which is why the column carries no CHECK constraint.
  if (body.client !== undefined && body.client !== null && body.client !== 'ios') {
    res.status(400).send('Unknown client');
    return;
  }
  const client: ProviderClient = body.client === 'ios' ? 'ios' : null;

  if (!body.action || !PROVIDER_ACTIONS[provider].has(body.action)) {
    res.status(400).send('Unknown action');
    return;
  }
  // Only the phone reads Health. Disconnect is the exception: an athlete may
  // end the connection from wherever they are signed in.
  if (provider === 'apple' && body.action !== 'disconnect' && client !== 'ios') {
    res.status(400).send('Apple Health actions come from the iOS app');
    return;
  }

  if (!(await enforceRateLimit(supabase, res, userId, 'providerSync'))) return;

  try {
    if (provider === 'apple' && (body.action === 'connect' || body.action === 'set-categories' || body.action === 'disconnect')) {
      await handleAppleLifecycle(supabase, res, userId, client, body);
      return;
    }
    switch (body.action) {
      case 'connect-start': {
        if (!isCorosConfigured()) {
          res.status(503).send('COROS integration is not configured on this deployment');
          return;
        }
        const state = generateState();
        const pkce = generatePkce();
        await beginOAuth(supabase, userId, provider, state, pkce.verifier, client);
        res.status(200).json({ authorizeUrl: await buildAuthorizeUrl(state, pkce) });
        return;
      }
      case 'disconnect': {
        await disconnect(supabase, userId, provider);
        // upstreamRevoked is false and says so out loud: Apex drops its tokens
        // but cannot end the grant at COROS (src/lib/sync/corosRevocation.ts),
        // and a user who clicked Disconnect is entitled to know that.
        res.status(200).json({
          ok: true,
          upstreamRevoked: COROS_UPSTREAM_REVOCATION_SUPPORTED,
          notice: COROS_DISCONNECT_NOTICE,
        });
        return;
      }
      case 'set-auto-sync': {
        if (typeof body.enabled !== 'boolean') {
          res.status(400).send('enabled must be a boolean');
          return;
        }
        await setAutoSync(supabase, userId, provider, body.enabled);
        res.status(200).json({ ok: true, autoSync: body.enabled });
        return;
      }
      case 'preview':
      case 'apply':
      case 'ingest': {
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

async function handleAppleLifecycle(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  res: VercelResponse,
  userId: string,
  client: ProviderClient,
  body: Body,
): Promise<void> {
  switch (body.action) {
    case 'connect': {
      if (!isValidTimezone(body.timezone)) {
        res.status(400).send('A valid IANA timezone is required');
        return;
      }
      const categories = body.categories === undefined ? {} : parseCategories(body.categories);
      if (!categories) {
        res.status(400).send('categories must be an object of known Health categories with boolean values');
        return;
      }
      const row = await connectLocal(supabase, userId, 'apple', { client, timezone: body.timezone, categories });
      res.status(200).json({ ok: true, apple: appleStatus(row) });
      return;
    }
    case 'set-categories': {
      const categories = parseCategories(body.categories);
      if (!categories || Object.keys(categories).length === 0) {
        res.status(400).send('categories must name at least one known Health category with a boolean value');
        return;
      }
      const stored = await setCategories(supabase, userId, 'apple', categories);
      if (!stored) {
        res.status(409).json({ error: 'not-connected' });
        return;
      }
      res.status(200).json({ ok: true, categories: stored });
      return;
    }
    case 'disconnect': {
      if (body.purgeMetrics !== undefined && typeof body.purgeMetrics !== 'boolean') {
        res.status(400).send('purgeMetrics must be a boolean');
        return;
      }
      const purged = body.purgeMetrics === true ? await purgeDailyMetrics(supabase, userId, 'apple') : 0;
      await disconnect(supabase, userId, 'apple');
      res.status(200).json({ ok: true, purged: { dailyMetrics: purged }, notice: APPLE_DISCONNECT_NOTICE });
      return;
    }
  }
}
