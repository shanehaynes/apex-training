import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { optionalEnv } from '../env.js';
import { listAutoSyncConnections, NotConnectedError } from '../providers/connection.js';
import { runAutoSync, type AutoSyncOutcome } from '../providers/sync.js';

// Nightly provider auto-sync, the cron target declared in vercel.json
// (03:30 UTC ≈ 11:30 PM Eastern in summer). Same auth as review-cron:
// Vercel sends Authorization: Bearer $CRON_SECRET on cron invocations.
//
// For every connected connection with auto_sync enabled (all providers —
// COROS today, Garmin/Apple when they land) it imports unmatched
// activities and counts planned-workout matches into pending_fill_count
// for the user to confirm in-app. Idempotent and self-healing like
// review-cron: no boundary flag — a user who pressed Sync earlier today
// simply yields an empty fetch (everything already in the ledger), and a
// missed night is absorbed by the watermark's 48 h overlap + 30 d floor.
//
// Escape hatches for manual operation: ?userId= limits to one user,
// ?dryRun=1 reports who WOULD sync without touching anything.

/** Far above any realistic user count for this personal app; a timeout
 *  backstop, not a fairness scheduler. */
const MAX_USERS_PER_RUN = 25;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secret = optionalEnv('CRON_SECRET');
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).send('Unauthorized');
    return;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const onlyUserId = typeof req.query.userId === 'string' ? req.query.userId : null;
  const dryRun = req.query.dryRun === '1';

  let connections;
  try {
    connections = await listAutoSyncConnections(supabase);
  } catch (err) {
    console.error('[provider-cron] listing failed:', err instanceof Error ? err.message : err);
    res.status(500).send('Failed to list connections');
    return;
  }
  if (onlyUserId) connections = connections.filter(c => c.user_id === onlyUserId);
  const deferred = Math.max(0, connections.length - MAX_USERS_PER_RUN);
  connections = connections.slice(0, MAX_USERS_PER_RUN);

  if (dryRun) {
    res.status(200).json({
      dryRun: true,
      wouldSync: connections.map(c => ({ provider: c.provider, timezone: c.timezone ?? 'UTC' })),
      deferred,
    });
    return;
  }

  const results: Array<{ provider: string; outcome?: AutoSyncOutcome; error?: string }> = [];
  for (const conn of connections) {
    // Provider dispatch: runAutoSync's COROS client is the only
    // implementation today; future providers widen this guard.
    if (conn.provider !== 'coros') {
      results.push({ provider: conn.provider, error: 'provider-not-implemented' });
      continue;
    }
    try {
      const outcome = await runAutoSync(supabase, conn.user_id, conn.provider, conn.timezone ?? 'UTC');
      results.push({ provider: conn.provider, outcome });
    } catch (err) {
      // Per-user isolation: one expired connection must not stop the run.
      const detail = err instanceof NotConnectedError ? err.reason : err instanceof Error ? err.message : 'unknown';
      console.error(`[provider-cron] auto-sync failed (${conn.provider}):`, detail);
      results.push({ provider: conn.provider, error: detail });
    }
  }

  const totals = results.reduce(
    (acc, r) => ({
      created: acc.created + (r.outcome?.created ?? 0),
      pendingFills: acc.pendingFills + (r.outcome?.pendingFills ?? 0),
      failures: acc.failures + (r.error ? 1 : 0),
    }),
    { created: 0, pendingFills: 0, failures: 0 },
  );
  console.log(`[provider-cron] ${results.length} connection(s): ${JSON.stringify(totals)}`);
  res.status(200).json({ connections: results.length, ...totals, deferred });
}
