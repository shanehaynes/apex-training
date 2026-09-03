import Anthropic from '@anthropic-ai/sdk';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser } from '../auth.js';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { getAnthropicKey } from '../anthropicKey.js';
import { enforceRateLimit } from '../rateLimit.js';
import { streamToWireEvents, type UpstreamEvent } from '../wire.js';
import { buildFinishSummary, loadResolvedOccurrence } from '../trackerSession.js';
import { athleteSection } from '../../../src/lib/coach/prompt.js';
import { defaultCoachModel, resolveCoachModel } from '../../../src/lib/coach/models.js';
import { sessionScoreFromRow } from '../../../src/lib/tracking/records.js';
import type { ChatWireEvent } from '../../../src/lib/coach/wire.js';

// Post-workout coach summary, running on the caller's own Anthropic key
// (server-only user_api_keys table). PRs are pre-computed inside the recap
// (src/lib/tracking/records.ts) — the model narrates them, never derives them.
//
// Two request shapes:
//   { eventId, eventDate }  (W3) — the server rebuilds the recap from the saved
//     rows, STREAMS the summary as NDJSON text events, and persists it on the
//     session itself. What every client uses.
//   { recap }               (legacy) — one-shot JSON { text } from a client-
//     built recap. Kept for a stale web bundle mid-session.

const SYSTEM_PROMPT =
  "You are the user's personal training coach reviewing a workout they just finished. " +
  'Write a brief, punchy summary: 2-4 sentences. Acknowledge the work, call out any ' +
  'personal records listed in the recap (they are pre-computed and verified — never ' +
  'invent records that are not listed), and make one pointed observation, e.g. skipped ' +
  'sets, a big jump versus last time, or a strong finish. If the recap includes a ' +
  'NUTRITION section, you may make the observation about fueling relative to the session ' +
  "(e.g. solid protein for recovery, light intake before hard work) — use only what is " +
  'listed, never invent intake, and never remark on the absence of logged meals. ' +
  'Speak directly to the user in second person. Plain prose only: no greeting, no ' +
  'sign-off, no markdown, no bullet points.';

const MAX_RECAP_CHARS = 20_000;

interface Body {
  eventId?: unknown;
  eventDate?: unknown;
  recap?: unknown;
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

  if (!(await enforceRateLimit(supabase, res, userId, 'summary'))) return;

  const body = (req.body ?? {}) as Body;
  const v2 = typeof body.eventId === 'string' && typeof body.eventDate === 'string';
  if (!v2 && (typeof body.recap !== 'string' || !body.recap.trim())) {
    res.status(400).send('Missing eventId and eventDate');
    return;
  }

  let apiKey: string | null;
  try {
    apiKey = await getAnthropicKey(supabase, userId);
  } catch (err) {
    console.error('[api/coach-summary] key lookup failed:', err instanceof Error ? err.message : err);
    res.status(500).send('Failed to load API key');
    return;
  }
  if (!apiKey) {
    // The summary popup degrades gracefully on this — no toast, no retry.
    res.status(402).send('anthropic-key-missing');
    return;
  }

  // Personalization and model choice are best-effort: a failed profile read
  // degrades to the generic prompt on the default model rather than failing
  // the summary.
  let athlete = '';
  let coachModel = defaultCoachModel();
  try {
    const { data } = await supabase
      .from('profiles')
      .select('coach_goal, coach_context, coach_model')
      .eq('id', userId)
      .maybeSingle();
    athlete = athleteSection(data?.coach_goal, data?.coach_context);
    coachModel = resolveCoachModel(data?.coach_model);
  } catch (err) {
    console.error('[api/coach-summary] profile read failed:', err instanceof Error ? err.message : err);
  }

  const client = new Anthropic({ apiKey });
  const request = (recap: string) => ({
    model: coachModel.id,
    max_tokens: 300,
    system: SYSTEM_PROMPT + athlete,
    messages: [{ role: 'user' as const, content: recap }],
  });

  // ── legacy: client-built recap, one-shot JSON ─────────────────────────────
  if (!v2) {
    const recap = body.recap as string;
    if (recap.length > MAX_RECAP_CHARS) {
      res.status(413).send('Recap too large');
      return;
    }
    try {
      const response = await client.messages.create(request(recap));
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('')
        .trim();
      if (!text) {
        res.status(502).send('Empty summary response');
        return;
      }
      res.status(200).json({ text });
    } catch (err) {
      console.error('[api/coach-summary] generation failed:', err);
      res.status(500).send('Summary generation failed');
    }
    return;
  }

  // ── v2: rebuild the recap from the saved rows, stream, persist ────────────
  const eventId = body.eventId as string;
  const eventDate = body.eventDate as string;

  const { data: session, error: sessionErr } = await supabase
    .from('workout_sessions')
    .select('*')
    .eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate)
    .maybeSingle();
  if (sessionErr) {
    console.error('[api/coach-summary] session read failed:', sessionErr.message);
    res.status(500).send('Failed to load session');
    return;
  }
  if (!session?.finished_at) {
    res.status(409).send('Session not finished');
    return;
  }

  let recap: string;
  try {
    const event = await loadResolvedOccurrence(supabase, userId, eventId, eventDate);
    if (!event) {
      res.status(404).send('No such event');
      return;
    }
    const summary = await buildFinishSummary(
      supabase, userId, event, session.total_duration_seconds, sessionScoreFromRow(session),
    );
    recap = summary.recap;
  } catch (err) {
    console.error('[api/coach-summary] recap build failed:', err instanceof Error ? err.message : err);
    res.status(500).send('Failed to build recap');
    return;
  }
  if (recap.length > MAX_RECAP_CHARS) {
    res.status(413).send('Recap too large');
    return;
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  let text = '';
  const send = (event: ChatWireEvent) => {
    if (event.type === 'text') text += event.delta;
    res.write(JSON.stringify(event) + '\n');
  };

  const upstreamAbort = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) upstreamAbort.abort(); });

  try {
    const stream = client.messages.stream(request(recap), { signal: upstreamAbort.signal });
    await streamToWireEvents(stream as AsyncIterable<UpstreamEvent>, send);
    const trimmed = text.trim();
    if (trimmed) {
      const { error } = await supabase
        .from('workout_sessions')
        .update({ coach_summary: trimmed, updated_at: new Date().toISOString() })
        .eq('user_id', userId).eq('event_id', eventId).eq('event_date', eventDate);
      if (error) console.error('[api/coach-summary] persist failed:', error.message);
    } else if (!upstreamAbort.signal.aborted) {
      send({ type: 'error', message: 'Empty summary response' });
    }
  } catch (err) {
    if (!upstreamAbort.signal.aborted) {
      console.error('[api/coach-summary] generation failed:', err);
      send({ type: 'error', message: 'Summary generation failed' });
    }
  }
  finished = true;
  res.end();
}
