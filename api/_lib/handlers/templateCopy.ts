import { randomUUID } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { optionalEnv } from '../env.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';
import { cloneEventRow, collectDefinitionIds } from '../../../src/lib/template/clone.js';
import type { ExerciseDefinitionRow, TablesInsert, WorkoutEventRow } from '../../../src/lib/db/types.js';

// Copies the template user's recurring workouts (plus every exercise
// definition they reference) onto the caller's calendar. One-time per
// account: profiles.template_copied_at is both the record and the
// idempotency lock, claimed atomically before any inserts so a double-click
// or retry can never duplicate the plan.

async function resolveSourceUserId(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
): Promise<string | null> {
  const fromEnv = optionalEnv('SEED_SOURCE_USER_ID');
  if (fromEnv) return fromEnv;
  const { data } = await supabase
    .from('profiles')
    .select('id')
    .eq('is_template_source', true)
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
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

  if (!(await enforceRateLimit(supabase, res, userId, 'reads'))) return;

  const sourceId = await resolveSourceUserId(supabase);
  if (!sourceId) {
    res.status(500).send('No template source configured');
    return;
  }
  if (sourceId === userId) {
    res.status(400).send('Template source cannot copy from itself');
    return;
  }

  // Claim the lock first. Zero rows updated = already copied (or no profile).
  const { data: locked, error: lockErr } = await supabase
    .from('profiles')
    .update({ template_copied_at: new Date().toISOString() })
    .eq('id', userId)
    .is('template_copied_at', null)
    .select('id');
  if (lockErr) {
    console.error('[api/template-copy] lock failed:', lockErr.message);
    res.status(500).send('Failed to start copy');
    return;
  }
  if (!locked || locked.length === 0) {
    // Losing the claim does not mean the plan is on the calendar: the winner
    // may still be mid-copy (the inserts happen after this point), and a
    // failed copy releases the claim again. So report WHEN the claim we lost
    // to was stamped and let the caller decide — a stamp from seconds ago is
    // a copy in flight, a null one is a claim that was just released.
    const { data: profile, error: readErr } = await supabase
      .from('profiles')
      .select('template_copied_at')
      .eq('id', userId)
      .maybeSingle();
    if (readErr) {
      console.error('[api/template-copy] claim read-back failed:', readErr.message);
      res.status(500).send('Failed to start copy');
      return;
    }
    // The other reason the UPDATE matched nothing: there is no profile row.
    if (!profile) {
      res.status(404).send('No profile for this account');
      return;
    }
    res.status(200).json({ alreadyCopied: true, copiedAt: profile.template_copied_at });
    return;
  }

  // Best-effort unlock so a failed copy can be retried.
  const releaseLock = () =>
    supabase.from('profiles').update({ template_copied_at: null }).eq('id', userId)
      .then(({ error }) => { if (error) console.error('[api/template-copy] unlock failed:', error.message); });

  const { data: sourceEvents, error: eventsErr } = await supabase
    .from('workout_events')
    .select('*')
    .eq('user_id', sourceId)
    .or('recurrence_rule.not.is.null,is_recurring.eq.true');
  if (eventsErr) {
    console.error('[api/template-copy] source events fetch failed:', eventsErr.message);
    await releaseLock();
    res.status(500).send('Failed to load template workouts');
    return;
  }

  const events = (sourceEvents ?? []) as WorkoutEventRow[];
  const definitionIds = collectDefinitionIds(events);

  let definitions: ExerciseDefinitionRow[] = [];
  if (definitionIds.length > 0) {
    const { data, error } = await supabase
      .from('exercise_definitions')
      .select('*')
      .eq('user_id', sourceId)
      .in('id', definitionIds);
    if (error) {
      console.error('[api/template-copy] source definitions fetch failed:', error.message);
      await releaseLock();
      res.status(500).send('Failed to load template exercises');
      return;
    }
    definitions = (data ?? []) as ExerciseDefinitionRow[];
  }

  // Definitions first (events reference them), ids preserved. ignoreDuplicates
  // keeps any same-slug exercise the user already created.
  if (definitions.length > 0) {
    const defClones = definitions.map(({ created_at: _c, updated_at: _u, ...rest }) => ({
      ...rest,
      user_id: userId,
    }));
    const { error } = await supabase
      .from('exercise_definitions')
      .upsert(defClones, { onConflict: 'user_id,id', ignoreDuplicates: true });
    if (error) {
      console.error('[api/template-copy] definition insert failed:', error.message);
      await releaseLock();
      res.status(500).send('Failed to copy exercises');
      return;
    }
  }

  if (events.length > 0) {
    const eventClones = events.map(row => cloneEventRow(row, `tpl-${randomUUID()}`, userId));
    const { error } = await supabase
      .from('workout_events')
      .insert(eventClones as TablesInsert<'workout_events'>[]);
    if (error) {
      console.error('[api/template-copy] event insert failed:', error.message);
      await releaseLock();
      res.status(500).send('Failed to copy workouts');
      return;
    }
  }

  // Deliberately not copied: exceptions, completions, sessions, logs — those
  // are the source user's history, not part of the plan.
  res.status(200).json({ events: events.length, definitions: definitions.length });
}
