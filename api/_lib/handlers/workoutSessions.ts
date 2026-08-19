import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import {
  pickAllowed,
  SET_LOG_COLUMNS,
  CARDIO_LOG_COLUMNS,
  SERVER_STAMPED_COLUMNS,
} from '../allowlist.js';
import { enforceRateLimit } from '../rateLimit.js';
import type { CardioLogRow, SetLogRow, TrackedSection } from '../../../src/lib/db/types.js';

// Single endpoint for the workout tracker's writes, discriminated by
// body.action (predates the consolidated router; /api/workout-sessions/*
// sub-paths would work through it now, but the action dispatch isn't worth
// churning). Reads go through the anon client (SELECT-only RLS policies).

interface RemovedSetKey {
  section: TrackedSection;
  exerciseId: string;
  setNumber: number;
}

interface Body {
  action?: 'start' | 'save' | 'finish' | 'cancel' | 'summary' | 'quick-complete' | 'quick-uncomplete' | 'swap-exercise';
  eventId?: string;
  eventDate?: string;
  setLogs?: SetLogRow[];
  cardioLogs?: CardioLogRow[];
  removedSets?: RemovedSetKey[];
  /** swap-exercise only: which logged exercise to relabel, and to what. */
  section?: TrackedSection;
  exerciseId?: string;
  exerciseName?: string;
  definitionId?: string | null;
  /** finish only: zero-fill rows for planned sets never logged (is_autofilled). */
  autofillRows?: SetLogRow[];
  /** summary only: AI-generated coach summary text to persist on the session. */
  coachSummary?: string;
  /** quick-complete only: recommended session length to stamp on the session. */
  durationSeconds?: number;
}

// user_id leads every conflict target: a forged event_id from another user
// can only ever upsert into the caller's own partition.
const SET_LOG_CONFLICT = 'user_id,event_id,event_date,section,exercise_id,set_number';
const CARDIO_CONFLICT = 'user_id,event_id,event_date,section,exercise_id';

// Far above any real workout (a heavy session logs well under 100 sets),
// low enough that one request can't insert an unbounded batch.
const MAX_BATCH_ROWS = 500;

const SECTIONS: ReadonlySet<string> = new Set(['warmup', 'exercise', 'cooldown']);

/**
 * Allowlist + identity-check one batch of set/cardio rows. SetLogRow /
 * CardioLogRow are compile-time types only — any authenticated caller can
 * post arbitrary JSON here, so the shape has to be enforced at runtime:
 * unknown columns are rejected (row ids and updated_at are server-owned)
 * and the conflict-target fields must be present and sane. Returns the
 * cleaned rows or sends the 400 itself and returns null.
 */
function prepareLogRows(
  res: VercelResponse,
  rows: unknown,
  columns: ReadonlySet<string>,
  label: string,
  requireSetNumber: boolean,
): Record<string, unknown>[] | null {
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) {
    res.status(400).send(`${label} must be an array`);
    return null;
  }
  if (rows.length > MAX_BATCH_ROWS) {
    res.status(400).send(`${label} cannot exceed ${MAX_BATCH_ROWS} rows`);
    return null;
  }

  const prepared: Record<string, unknown>[] = [];
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      res.status(400).send(`${label}[${i}] is not an object`);
      return null;
    }
    const { picked, rejected } = pickAllowed(raw as Record<string, unknown>, columns, SERVER_STAMPED_COLUMNS);
    if (rejected.length > 0) {
      console.error(`[api/workout-sessions] ${label} rejected unknown fields:`, rejected.join(', '));
      res.status(400).send(`${label}[${i}] has unknown fields: ${rejected.join(', ')}`);
      return null;
    }
    if (
      typeof picked.event_id !== 'string' ||
      typeof picked.event_date !== 'string' ||
      typeof picked.exercise_id !== 'string' ||
      !SECTIONS.has(picked.section as string)
    ) {
      res.status(400).send(`${label}[${i}] is missing event_id, event_date, exercise_id, or a valid section`);
      return null;
    }
    if (requireSetNumber && !Number.isInteger(picked.set_number)) {
      res.status(400).send(`${label}[${i}] needs an integer set_number`);
      return null;
    }
    prepared.push(picked);
  }
  return prepared;
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

  // Its own generous bucket, not 'writes': tracker autosave fires on a
  // debounce throughout a session and would starve event edits of quota.
  if (!(await enforceRateLimit(supabase, res, userId, 'tracker'))) return;

  const body = req.body as Body | undefined;
  if (!body?.action || !body.eventId || !body.eventDate) {
    res.status(400).send('Missing action, eventId, or eventDate');
    return;
  }
  const { eventId, eventDate } = body;

  // ── start: get-or-create the session, preserving the original started_at ──
  if (body.action === 'start') {
    const { error: insertErr } = await supabase
      .from('workout_sessions')
      .upsert(
        { user_id: userId, event_id: eventId, event_date: eventDate, started_at: new Date().toISOString() },
        { onConflict: 'user_id,event_id,event_date', ignoreDuplicates: true },
      );
    if (insertErr) {
      console.error('[api/workout-sessions] start upsert failed:', insertErr.message);
      res.status(500).send('Failed to start session');
      return;
    }

    const { data, error: selectErr } = await supabase
      .from('workout_sessions')
      .select('*')
      .eq('user_id', userId).eq('event_id', eventId)
      .eq('event_date', eventDate)
      .single();
    if (selectErr || !data) {
      console.error('[api/workout-sessions] start select failed:', selectErr?.message);
      res.status(500).send('Failed to load session');
      return;
    }

    res.status(200).json({ session: data });
    return;
  }

  // ── save: idempotent upsert of everything the client touched ──────────────
  if (body.action === 'save') {
    const setLogs = prepareLogRows(res, body.setLogs, SET_LOG_COLUMNS, 'setLogs', true);
    if (!setLogs) return;
    const cardioLogs = prepareLogRows(res, body.cardioLogs, CARDIO_LOG_COLUMNS, 'cardioLogs', false);
    if (!cardioLogs) return;
    if ((body.removedSets?.length ?? 0) > MAX_BATCH_ROWS) {
      res.status(400).send(`removedSets cannot exceed ${MAX_BATCH_ROWS} rows`);
      return;
    }

    const now = new Date().toISOString();
    const ops: PromiseLike<{ error: { message: string } | null }>[] = [];

    if (setLogs.length) {
      ops.push(supabase
        .from('workout_set_logs')
        .upsert(setLogs.map(r => ({ ...r, user_id: userId, updated_at: now })), { onConflict: SET_LOG_CONFLICT }));
    }
    if (cardioLogs.length) {
      ops.push(supabase
        .from('workout_cardio_logs')
        .upsert(cardioLogs.map(r => ({ ...r, user_id: userId, updated_at: now })), { onConflict: CARDIO_CONFLICT }));
    }
    for (const key of body.removedSets ?? []) {
      ops.push(supabase
        .from('workout_set_logs')
        .delete()
        .eq('user_id', userId).eq('event_id', eventId)
        .eq('event_date', eventDate)
        .eq('section', key.section)
        .eq('exercise_id', key.exerciseId)
        .eq('set_number', key.setNumber));
    }

    const results = await Promise.all(ops);
    const failed = results.find(r => r.error);
    if (failed?.error) {
      console.error('[api/workout-sessions] save failed:', failed.error.message);
      res.status(500).send('Failed to save logs');
      return;
    }

    res.status(200).json({ ok: true });
    return;
  }

  // ── finish: stamp duration + zero-fill planned sets never logged ──────────
  if (body.action === 'finish') {
    // Validate before any write so a bad batch can't leave the session
    // half-finished (stamped but with its zero-fills rejected).
    const autofillRows = prepareLogRows(res, body.autofillRows, SET_LOG_COLUMNS, 'autofillRows', true);
    if (!autofillRows) return;

    const { data: session, error: sessionErr } = await supabase
      .from('workout_sessions')
      .select('*')
      .eq('user_id', userId).eq('event_id', eventId)
      .eq('event_date', eventDate)
      .single();
    if (sessionErr || !session) {
      console.error('[api/workout-sessions] finish: session not found:', sessionErr?.message);
      res.status(404).send('Session not started');
      return;
    }

    const finishedAt = new Date();
    const totalSeconds = Math.max(
      0,
      Math.round((finishedAt.getTime() - new Date(session.started_at as string).getTime()) / 1000),
    );

    const { error: updateErr } = await supabase
      .from('workout_sessions')
      .update({
        finished_at: finishedAt.toISOString(),
        total_duration_seconds: totalSeconds,
        updated_at: finishedAt.toISOString(),
      })
      .eq('user_id', userId).eq('event_id', eventId)
      .eq('event_date', eventDate);
    if (updateErr) {
      console.error('[api/workout-sessions] finish update failed:', updateErr.message);
      res.status(500).send('Failed to finish session');
      return;
    }

    // ignoreDuplicates: a set logged between the client building the
    // autofill list and this request landing is never overwritten with zeros.
    if (autofillRows.length) {
      const { error: fillErr } = await supabase
        .from('workout_set_logs')
        .upsert(
          autofillRows.map(r => ({ ...r, user_id: userId, is_autofilled: true })),
          { onConflict: SET_LOG_CONFLICT, ignoreDuplicates: true },
        );
      if (fillErr) {
        console.error('[api/workout-sessions] finish autofill failed:', fillErr.message);
        res.status(500).send('Failed to record skipped sets');
        return;
      }
    }

    res.status(200).json({ ok: true, totalDurationSeconds: totalSeconds });
    return;
  }

  // ── summary: persist the AI coach summary generated client-side at Finish ──
  if (body.action === 'summary') {
    if (typeof body.coachSummary !== 'string' || !body.coachSummary.trim()) {
      res.status(400).send('Missing coachSummary');
      return;
    }
    if (body.coachSummary.length > 20_000) {
      res.status(400).send('coachSummary is too long');
      return;
    }
    const { error: summaryErr } = await supabase
      .from('workout_sessions')
      .update({ coach_summary: body.coachSummary, updated_at: new Date().toISOString() })
      .eq('user_id', userId).eq('event_id', eventId)
      .eq('event_date', eventDate);
    if (summaryErr) {
      console.error('[api/workout-sessions] summary update failed:', summaryErr.message);
      res.status(500).send('Failed to save summary');
      return;
    }

    res.status(200).json({ ok: true });
    return;
  }

  // ── quick-complete: "Mark as Complete" logs the whole plan as done ────────
  // Set/cardio rows arrive pre-built at planned targets (is_autofilled).
  // Every upsert ignores duplicates, so anything hand-logged — including a
  // partially tracked session — is never overwritten.
  if (body.action === 'quick-complete') {
    const setLogs = prepareLogRows(res, body.setLogs, SET_LOG_COLUMNS, 'setLogs', true);
    if (!setLogs) return;
    const cardioLogs = prepareLogRows(res, body.cardioLogs, CARDIO_LOG_COLUMNS, 'cardioLogs', false);
    if (!cardioLogs) return;

    // A 400 beats the opaque 500 that Infinity/NaN produces at the DB. A
    // week is far beyond any recommended session length.
    if (body.durationSeconds !== undefined &&
        (typeof body.durationSeconds !== 'number' ||
         !Number.isFinite(body.durationSeconds) ||
         body.durationSeconds < 0 ||
         body.durationSeconds > 7 * 24 * 3600)) {
      res.status(400).send('durationSeconds must be a finite number of seconds');
      return;
    }

    const now = new Date().toISOString();

    const { error: sessionErr } = await supabase
      .from('workout_sessions')
      .upsert(
        { user_id: userId, event_id: eventId, event_date: eventDate, started_at: now },
        { onConflict: 'user_id,event_id,event_date', ignoreDuplicates: true },
      );
    if (sessionErr) {
      console.error('[api/workout-sessions] quick-complete session upsert failed:', sessionErr.message);
      res.status(500).send('Failed to quick-complete session');
      return;
    }

    // Stamp unfinished sessions with the recommended duration; a genuinely
    // tracked-and-finished session keeps its measured time.
    const { error: finishErr } = await supabase
      .from('workout_sessions')
      .update({
        finished_at: now,
        total_duration_seconds: typeof body.durationSeconds === 'number' ? Math.round(body.durationSeconds) : null,
        updated_at: now,
      })
      .eq('user_id', userId).eq('event_id', eventId)
      .eq('event_date', eventDate)
      .is('finished_at', null);
    if (finishErr) {
      console.error('[api/workout-sessions] quick-complete finish failed:', finishErr.message);
      res.status(500).send('Failed to quick-complete session');
      return;
    }

    const ops: PromiseLike<{ error: { message: string } | null }>[] = [];
    if (setLogs.length) {
      ops.push(supabase
        .from('workout_set_logs')
        .upsert(
          setLogs.map(r => ({ ...r, user_id: userId, is_autofilled: true, updated_at: now })),
          { onConflict: SET_LOG_CONFLICT, ignoreDuplicates: true },
        ));
    }
    if (cardioLogs.length) {
      ops.push(supabase
        .from('workout_cardio_logs')
        .upsert(
          cardioLogs.map(r => ({ ...r, user_id: userId, is_autofilled: true, updated_at: now })),
          { onConflict: CARDIO_CONFLICT, ignoreDuplicates: true },
        ));
    }
    const results = await Promise.all(ops);
    const failed = results.find(r => r.error);
    if (failed?.error) {
      console.error('[api/workout-sessions] quick-complete logs failed:', failed.error.message);
      res.status(500).send('Failed to log planned work');
      return;
    }

    res.status(200).json({ ok: true });
    return;
  }

  // ── quick-uncomplete: undo the toggle — drop only system-filled rows ──────
  // Hand-entered logs survive. Note zero-fills from a real Finish share the
  // is_autofilled flag and are dropped too; re-finishing recreates them.
  if (body.action === 'quick-uncomplete') {
    const deletes = await Promise.all([
      supabase.from('workout_set_logs').delete()
        .eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate).eq('is_autofilled', true),
      supabase.from('workout_cardio_logs').delete()
        .eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate).eq('is_autofilled', true),
    ]);
    const failedDelete = deletes.find(r => r.error);
    if (failedDelete?.error) {
      console.error('[api/workout-sessions] quick-uncomplete delete failed:', failedDelete.error.message);
      res.status(500).send('Failed to remove quick-completed logs');
      return;
    }

    // A session with no logs left was created by the toggle — drop it so the
    // tracker starts fresh instead of resuming a phantom finished session.
    const [setsLeft, cardioLeft] = await Promise.all([
      supabase.from('workout_set_logs').select('id', { count: 'exact', head: true })
        .eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate),
      supabase.from('workout_cardio_logs').select('id', { count: 'exact', head: true })
        .eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate),
    ]);
    if ((setsLeft.count ?? 0) === 0 && (cardioLeft.count ?? 0) === 0) {
      const { error: sessionErr } = await supabase
        .from('workout_sessions').delete()
        .eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate);
      if (sessionErr) {
        console.error('[api/workout-sessions] quick-uncomplete session delete failed:', sessionErr.message);
        res.status(500).send('Failed to remove quick-completed session');
        return;
      }
    }

    res.status(200).json({ ok: true });
    return;
  }

  // ── swap-exercise: relabel one exercise's logs onto another movement ──────
  // "I logged ring dips but actually did single-arm DB press." Only the log
  // rows for this event+date move; the plan is untouched, so a recurring
  // series keeps its prescription and the other occurrences keep theirs. The
  // exercise_id stays put — it is what the sets are keyed on.
  if (body.action === 'swap-exercise') {
    const { section, exerciseId, exerciseName, definitionId } = body;
    if (!SECTIONS.has(section as string) || typeof exerciseId !== 'string' || !exerciseId) {
      res.status(400).send('swap-exercise needs an exerciseId and a valid section');
      return;
    }
    if (typeof exerciseName !== 'string' || !exerciseName.trim() || exerciseName.length > 200) {
      res.status(400).send('swap-exercise needs a non-empty exerciseName under 200 characters');
      return;
    }
    if (definitionId !== undefined && definitionId !== null && typeof definitionId !== 'string') {
      res.status(400).send('definitionId must be a string or null');
      return;
    }

    const patch = {
      exercise_name: exerciseName.trim(),
      definition_id: definitionId ?? null,
      updated_at: new Date().toISOString(),
    };
    const scope = (table: string) => supabase
      .from(table)
      .update(patch)
      .eq('user_id', userId).eq('event_id', eventId)
      .eq('event_date', eventDate)
      .eq('section', section)
      .eq('exercise_id', exerciseId);

    const results = await Promise.all([scope('workout_set_logs'), scope('workout_cardio_logs')]);
    const failed = results.find(r => r.error);
    if (failed?.error) {
      console.error('[api/workout-sessions] swap-exercise failed:', failed.error.message);
      res.status(500).send('Failed to swap exercise');
      return;
    }

    res.status(200).json({ ok: true });
    return;
  }

  // ── cancel: forget the session entirely — no resume, no history ────────────
  if (body.action === 'cancel') {
    const results = await Promise.all([
      supabase.from('workout_set_logs').delete().eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate),
      supabase.from('workout_cardio_logs').delete().eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate),
      supabase.from('workout_sessions').delete().eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate),
    ]);
    const failed = results.find(r => r.error);
    if (failed?.error) {
      console.error('[api/workout-sessions] cancel failed:', failed.error.message);
      res.status(500).send('Failed to cancel session');
      return;
    }

    res.status(200).json({ ok: true });
    return;
  }

  res.status(400).send('Unknown action');
}
