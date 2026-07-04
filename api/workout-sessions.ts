import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';

// Single endpoint for the workout tracker's writes, discriminated by
// body.action — Vercel file routing maps one file to one path, and the
// catch-all rewrite in vercel.json would swallow /api/workout-sessions/*
// sub-paths. Reads go through the anon client (SELECT-only RLS policies).

interface SetLogRow {
  event_id: string;
  event_date: string;
  section: 'warmup' | 'exercise' | 'cooldown';
  exercise_id: string;
  exercise_name: string;
  set_number: number;
  planned_weight: string | null;
  planned_reps: string | null;
  planned_duration: string | null;
  actual_weight: string | null;
  actual_reps: string | null;
  actual_duration: string | null;
  is_autofilled: boolean;
}

interface CardioLogRow {
  event_id: string;
  event_date: string;
  section: 'warmup' | 'exercise' | 'cooldown';
  exercise_id: string;
  exercise_name: string;
  duration_minutes: number | null;
  distance: string | null;
  elevation_gain: string | null;
  avg_heart_rate: number | null;
}

interface RemovedSetKey {
  section: 'warmup' | 'exercise' | 'cooldown';
  exerciseId: string;
  setNumber: number;
}

interface Body {
  action?: 'start' | 'save' | 'finish' | 'cancel' | 'summary';
  eventId?: string;
  eventDate?: string;
  setLogs?: SetLogRow[];
  cardioLogs?: CardioLogRow[];
  removedSets?: RemovedSetKey[];
  /** finish only: zero-fill rows for planned sets never logged (is_autofilled). */
  autofillRows?: SetLogRow[];
  /** summary only: AI-generated coach summary text to persist on the session. */
  coachSummary?: string;
}

const SET_LOG_CONFLICT = 'event_id,event_date,section,exercise_id,set_number';
const CARDIO_CONFLICT = 'event_id,event_date,section,exercise_id';

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
        { event_id: eventId, event_date: eventDate, started_at: new Date().toISOString() },
        { onConflict: 'event_id,event_date', ignoreDuplicates: true },
      );
    if (insertErr) {
      console.error('[api/workout-sessions] start upsert failed:', insertErr.message);
      res.status(500).send('Failed to start session');
      return;
    }

    const { data, error: selectErr } = await supabase
      .from('workout_sessions')
      .select('*')
      .eq('event_id', eventId)
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
        .upsert(body.setLogs.map(r => ({ ...r, updated_at: now })), { onConflict: SET_LOG_CONFLICT }));
    }
    if (body.cardioLogs?.length) {
      ops.push(supabase
        .from('workout_cardio_logs')
        .upsert(body.cardioLogs.map(r => ({ ...r, updated_at: now })), { onConflict: CARDIO_CONFLICT }));
    }
    for (const key of body.removedSets ?? []) {
      ops.push(supabase
        .from('workout_set_logs')
        .delete()
        .eq('event_id', eventId)
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
      .eq('event_id', eventId)
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
      .eq('event_id', eventId)
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
          body.autofillRows.map(r => ({ ...r, is_autofilled: true })),
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
    const { error: summaryErr } = await supabase
      .from('workout_sessions')
      .update({ coach_summary: body.coachSummary, updated_at: new Date().toISOString() })
      .eq('event_id', eventId)
      .eq('event_date', eventDate);
    if (summaryErr) {
      console.error('[api/workout-sessions] summary update failed:', summaryErr.message);
      res.status(500).send('Failed to save summary');
      return;
    }

    res.status(200).json({ ok: true });
    return;
  }

  // ── cancel: forget the session entirely — no resume, no history ────────────
  if (body.action === 'cancel') {
    const results = await Promise.all([
      supabase.from('workout_set_logs').delete().eq('event_id', eventId).eq('event_date', eventDate),
      supabase.from('workout_cardio_logs').delete().eq('event_id', eventId).eq('event_date', eventDate),
      supabase.from('workout_sessions').delete().eq('event_id', eventId).eq('event_date', eventDate),
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
