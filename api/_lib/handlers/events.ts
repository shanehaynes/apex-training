import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { pickAllowed, EVENT_INSERT_COLUMNS, EVENT_PATCH_COLUMNS, EVENT_ID_PATTERN } from '../allowlist.js';
import { enforceAiMutationCap, enforceRateLimit } from '../rateLimit.js';
import { handleTrainingBlocks } from '../trainingBlocks.js';
import { handleMeals } from '../meals.js';
import { handleMealFavorites } from '../mealFavorites.js';
import type { WorkoutEventRow } from '../../../src/lib/db/types.js';

interface MutationLogEntry {
  event_title: string;
  event_date?: string;
  diff?: Record<string, unknown>;
  /** Omitted → the DB default ('ai'); UI-driven edits send 'user'. */
  triggered_by?: 'ai' | 'user';
}

async function logMutation(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  userId: string,
  operation: 'create' | 'update' | 'delete',
  eventId: string,
  log: MutationLogEntry,
) {
  const { error } = await supabase.from('event_mutations_log').insert({
    user_id: userId,
    operation,
    event_id: eventId,
    event_title: log.event_title,
    event_date: log.event_date,
    diff: log.diff,
    // Runtime guard, not just the type: the entry arrives in request bodies.
    ...(log.triggered_by === 'ai' || log.triggered_by === 'user'
      ? { triggered_by: log.triggered_by }
      : {}),
  });
  if (error) console.error('[api/events] mutation log insert failed:', error.message);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // TODO(delete next release): back-compat shim for the pre-router
  // ?resource=block|objective|meal|meal-favorite URLs, kept one release so
  // stale SPA bundles in open tabs keep working. New code uses the clean
  // paths (/api/blocks, /api/objectives, /api/meals, /api/meal-favorites)
  // routed by _lib/app.ts. Each delegate does its own auth, rate limiting,
  // and allowlisting; nothing below these branches runs for them.
  if (req.query.resource === 'block' || req.query.resource === 'objective') {
    await handleTrainingBlocks(req, res);
    return;
  }
  if (req.query.resource === 'meal') {
    await handleMeals(req, res);
    return;
  }
  if (req.query.resource === 'meal-favorite') {
    await handleMealFavorites(req, res);
    return;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const userId = await requireUser(req, res);
  if (!userId) return;

  if (!(await enforceRateLimit(supabase, res, userId, 'writes'))) return;

  if (req.method === 'POST') {
    const { triggered_by, ...row } = (req.body ?? {}) as Partial<WorkoutEventRow> & { triggered_by?: unknown };
    if (typeof row.id !== 'string' || typeof row.title !== 'string') {
      res.status(400).send('Missing required event fields');
      return;
    }
    // Ids reach the ICS feed and occurrence-id composition — enforce the
    // slug shape here so a CRLF or oversized id never lands in the table.
    if (!EVENT_ID_PATTERN.test(row.id)) {
      res.status(400).send('Invalid event id — use letters, digits, hyphens, underscores (max 128)');
      return;
    }
    if (row.title.length > 300) {
      res.status(400).send('Event title is too long');
      return;
    }
    const triggeredBy = triggered_by === 'user' || triggered_by === 'ai' ? triggered_by : undefined;

    // Requests not explicitly user-triggered count against the daily AI cap
    // (the coach path and unlabeled callers — matches the log's 'ai' default).
    if (triggeredBy !== 'user' && !(await enforceAiMutationCap(supabase, res, userId))) return;

    const { picked, rejected } = pickAllowed(row as Record<string, unknown>, EVENT_INSERT_COLUMNS);
    if (rejected.length > 0) {
      console.error('[api/events] insert rejected unknown fields:', rejected.join(', '));
      res.status(400).send(`Unknown event fields: ${rejected.join(', ')}`);
      return;
    }

    const { error } = await supabase.from('workout_events').insert({ ...picked, user_id: userId });
    if (error) {
      console.error('[api/events] insert failed:', error.message);
      res.status(500).send('Failed to create event');
      return;
    }

    await logMutation(supabase, userId, 'create', row.id, {
      event_title: row.title,
      event_date: row.date,
      triggered_by: triggeredBy,
    });
    res.status(200).json({ id: row.id });
    return;
  }

  const id = typeof req.query.id === 'string' ? req.query.id : undefined;
  if (!id) {
    res.status(400).send('Missing id');
    return;
  }

  if (req.method === 'PATCH') {
    const body = req.body as { fields?: Partial<WorkoutEventRow>; log?: MutationLogEntry } | undefined;
    if (!body?.fields || !body.log) {
      res.status(400).send('Missing fields or log');
      return;
    }

    if (body.log.triggered_by !== 'user' && !(await enforceAiMutationCap(supabase, res, userId))) return;

    const { picked, rejected } = pickAllowed(body.fields as Record<string, unknown>, EVENT_PATCH_COLUMNS);
    if (rejected.length > 0) {
      console.error('[api/events] update rejected unknown fields:', rejected.join(', '));
      res.status(400).send(`Unknown event fields: ${rejected.join(', ')}`);
      return;
    }

    // .select('id') exposes the affected rows: Supabase reports no error on
    // a 0-row update, which used to return 200 and write a phantom audit
    // entry for someone else's (or a mistyped) id.
    const { data: updated, error } = await supabase
      .from('workout_events')
      .update({ ...picked, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
      .select('id');

    if (error) {
      console.error('[api/events] update failed:', error.message);
      res.status(500).send('Failed to update event');
      return;
    }
    if (!updated || updated.length === 0) {
      res.status(404).send('Event not found');
      return;
    }

    await logMutation(supabase, userId, 'update', id, body.log);
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    const body = req.body as { log?: MutationLogEntry } | undefined;

    if (body?.log?.triggered_by !== 'user' && !(await enforceAiMutationCap(supabase, res, userId))) return;

    const { data: deleted, error } = await supabase
      .from('workout_events')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)
      .select('id');
    if (error) {
      console.error('[api/events] delete failed:', error.message);
      res.status(500).send('Failed to delete event');
      return;
    }
    if (!deleted || deleted.length === 0) {
      res.status(404).send('Event not found');
      return;
    }

    await logMutation(supabase, userId, 'delete', id, body?.log ?? { event_title: id });
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).send('Method not allowed');
}
