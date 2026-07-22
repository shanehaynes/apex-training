import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';
import { requireUser } from './_lib/auth.js';
import type { CardioLogRow, SetLogRow, TrackedSection } from '../src/lib/db/types.js';

// Single endpoint for the workout tracker's writes, discriminated by
// body.action — Vercel file routing maps one file to one path, and the
// catch-all rewrite in vercel.json would swallow /api/workout-sessions/*
// sub-paths. Reads go through the anon client (SELECT-only RLS policies).

interface RemovedSetKey {
  section: TrackedSection;
  exerciseId: string;
  setNumber: number;
}

interface Body {
  action?: 'start' | 'save' | 'finish' | 'cancel' | 'summary' | 'quick-complete' | 'quick-uncomplete';
  eventId?: string;
  eventDate?: string;
  setLogs?: SetLogRow[];
  cardioLogs?: CardioLogRow[];
  removedSets?: RemovedSetKey[];
  /** finish only: zero-fill rows for planned sets never logged (is_autofilled). */
  autofillRows?: SetLogRow[];
  /** finish only: untouched prefilled cardio persisted at last session's values. */
  autofillCardioRows?: CardioLogRow[];
  /** summary only: AI-generated coach summary text to persist on the session. */
  coachSummary?: string;
  /** quick-complete only: recommended session length to stamp on the session. */
  durationSeconds?: number;
}

// user_id leads every conflict target: a forged event_id from another user
// can only ever upsert into the caller's own partition.
const SET_LOG_CONFLICT = 'user_id,event_id,event_date,section,exercise_id,set_number';
const CARDIO_CONFLICT = 'user_id,event_id,event_date,section,exercise_id';

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
    const now = new Date().toISOString();
    const ops: PromiseLike<{ error: { message: string } | null }>[] = [];

    if (body.setLogs?.length) {
      ops.push(supabase
        .from('workout_set_logs')
        .upsert(body.setLogs.map(r => ({ ...r, user_id: userId, updated_at: now })), { onConflict: SET_LOG_CONFLICT }));
    }
    if (body.cardioLogs?.length) {
      ops.push(supabase
        .from('workout_cardio_logs')
        .upsert(body.cardioLogs.map(r => ({ ...r, user_id: userId, updated_at: now })), { onConflict: CARDIO_CONFLICT }));
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
    if (body.autofillRows?.length) {
      const { error: fillErr } = await supabase
        .from('workout_set_logs')
        .upsert(
          body.autofillRows.map(r => ({ ...r, user_id: userId, is_autofilled: true })),
          { onConflict: SET_LOG_CONFLICT, ignoreDuplicates: true },
        );
      if (fillErr) {
        console.error('[api/workout-sessions] finish autofill failed:', fillErr.message);
        res.status(500).send('Failed to record skipped sets');
        return;
      }
    }

    if (body.autofillCardioRows?.length) {
      const { error: cardioFillErr } = await supabase
        .from('workout_cardio_logs')
        .upsert(
          body.autofillCardioRows.map(r => ({ ...r, user_id: userId, is_autofilled: true })),
          { onConflict: CARDIO_CONFLICT, ignoreDuplicates: true },
        );
      if (cardioFillErr) {
        console.error('[api/workout-sessions] finish cardio autofill failed:', cardioFillErr.message);
        res.status(500).send('Failed to record prefilled cardio');
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
    if (body.setLogs?.length) {
      ops.push(supabase
        .from('workout_set_logs')
        .upsert(
          body.setLogs.map(r => ({ ...r, user_id: userId, is_autofilled: true, updated_at: now })),
          { onConflict: SET_LOG_CONFLICT, ignoreDuplicates: true },
        ));
    }
    if (body.cardioLogs?.length) {
      ops.push(supabase
        .from('workout_cardio_logs')
        .upsert(
          body.cardioLogs.map(r => ({ ...r, user_id: userId, is_autofilled: true, updated_at: now })),
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
