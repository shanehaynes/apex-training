import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';
import { requireUser } from './_lib/auth.js';

// Read-only feed of the caller's mutation audit logs, merged across events,
// definitions, and blocks/objectives — backs the "Coach activity" list in
// the profile. The logs themselves are server-only tables (RLS with no anon
// policy), so this is the sole way the client sees them.

export interface ActivityEntry {
  source: 'event' | 'definition' | 'block' | 'objective';
  operation: string;
  title: string;
  event_date: string | null;
  triggered_by: string;
  logged_at: string;
}

const LIMIT = 100;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
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

  const [events, definitions, blocks] = await Promise.all([
    supabase
      .from('event_mutations_log')
      .select('operation, event_title, event_date, triggered_by, logged_at')
      .eq('user_id', userId)
      .order('logged_at', { ascending: false })
      .limit(LIMIT),
    supabase
      .from('definition_mutations_log')
      .select('operation, definition_name, triggered_by, logged_at')
      .eq('user_id', userId)
      .order('logged_at', { ascending: false })
      .limit(LIMIT),
    supabase
      .from('block_mutations_log')
      .select('operation, resource, resource_name, triggered_by, logged_at')
      .eq('user_id', userId)
      .order('logged_at', { ascending: false })
      .limit(LIMIT),
  ]);

  if (events.error || definitions.error || blocks.error) {
    console.error(
      '[api/mutations-log] read failed:',
      events.error?.message ?? definitions.error?.message ?? blocks.error?.message,
    );
    res.status(500).send('Failed to load activity');
    return;
  }

  const entries: ActivityEntry[] = [
    ...(events.data ?? []).map(r => ({
      source: 'event' as const,
      operation: r.operation as string,
      title: r.event_title as string,
      event_date: (r.event_date as string | null) ?? null,
      triggered_by: r.triggered_by as string,
      logged_at: r.logged_at as string,
    })),
    ...(definitions.data ?? []).map(r => ({
      source: 'definition' as const,
      operation: r.operation as string,
      title: r.definition_name as string,
      event_date: null,
      triggered_by: r.triggered_by as string,
      logged_at: r.logged_at as string,
    })),
    // trainingBlocks.ts writes one row per block/objective mutation; until
    // this merge, those were invisible in Coach activity.
    ...(blocks.data ?? []).map(r => ({
      source: (r.resource === 'objective' ? 'objective' : 'block') as 'block' | 'objective',
      operation: r.operation as string,
      title: r.resource_name as string,
      event_date: null,
      triggered_by: r.triggered_by as string,
      logged_at: r.logged_at as string,
    })),
  ]
    .sort((a, b) => b.logged_at.localeCompare(a.logged_at))
    .slice(0, LIMIT);

  res.status(200).json({ entries });
}
