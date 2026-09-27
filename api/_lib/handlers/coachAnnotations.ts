import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';
import {
  isDayId,
  isSeverity,
  isTargetKind,
  normalizeBody,
  targetProblem,
  type AnnotationSeverity,
  type AnnotationTargetKind,
} from '../../../src/lib/coach/annotations.js';

// Coach annotations: a note pinned to a day, an event occurrence or a block,
// over the phaseXX coach_annotations table. The calendar reads them for the
// month it is showing; the coach's `leave_note` tool (wave D) writes them;
// the athlete dismisses them in place.
//
// ROUTING: method plus shape, no ?op= verb (the coach-conversations posture).
//   GET    ?from=YYYY-MM-DD&to=YYYY-MM-DD → live notes: day targets inside
//                                          the range, plus EVERY live event
//                                          and block note (hobby scale — an
//                                          occurrence id carries its date but
//                                          a block spans months, and one
//                                          extra query is cheaper than a
//                                          range join the client would have
//                                          to mirror)
//   POST   { target_kind, target_id, body, severity? } → create; the server
//                                          stamps created_by = 'coach'
//   DELETE { id }                        → dismiss: sets dismissed_at, never
//                                          deletes the row
//
// Every query is scoped with .eq('user_id', userId). The user id comes from
// the JWT via requireUser and never from the body or the query.
//
// Buckets: the GET rides `reads` (it fires once per visible month, like the
// other native-client reads), the writes ride `writes` — a note is a row
// like any other, and a runaway tool loop should hit the same wall an event
// storm does.

const COLUMNS = 'id, target_kind, target_id, body, severity, created_by, created_at, dismissed_at';

/** Widest range one GET serves. The month grid is six weeks; a year is the
 *  ceiling for a client that wants to prefetch, and past it the query is not
 *  a calendar read any more. */
const MAX_RANGE_DAYS = 366;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const method = req.method ?? 'GET';
  if (!['GET', 'POST', 'DELETE'].includes(method)) {
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

  const bucket = method === 'GET' ? 'reads' : 'writes';
  if (!(await enforceRateLimit(supabase, res, userId, bucket))) return;

  const body = (req.body ?? {}) as Record<string, unknown>;

  // ── GET ?from=&to= — live notes for a visible range ───────────────────────

  if (method === 'GET') {
    const from = first(req.query.from as string | string[] | undefined) ?? '';
    const to = first(req.query.to as string | string[] | undefined) ?? '';
    if (!isDayId(from) || !isDayId(to)) {
      res.status(400).send('Query must carry from=YYYY-MM-DD and to=YYYY-MM-DD');
      return;
    }
    const span = daysBetween(from, to);
    if (span < 0 || span > MAX_RANGE_DAYS) {
      res.status(400).send(`Range must run forward and cover at most ${MAX_RANGE_DAYS} days`);
      return;
    }

    // Two queries, not one: the day filter is a text range on target_id that
    // only means something for the 'day' kind, and event/block notes are
    // wanted whole. The partial index on dismissed_at is null serves both.
    const [days, rest] = await Promise.all([
      supabase
        .from('coach_annotations')
        .select(COLUMNS)
        .eq('user_id', userId)
        .eq('target_kind', 'day')
        .is('dismissed_at', null)
        .gte('target_id', from)
        .lte('target_id', to),
      supabase
        .from('coach_annotations')
        .select(COLUMNS)
        .eq('user_id', userId)
        .in('target_kind', ['event', 'block'])
        .is('dismissed_at', null),
    ]);
    const failed = days.error ?? rest.error;
    if (failed) {
      console.error('[api/coach-annotations] list failed:', failed.message);
      res.status(500).send('Failed to load annotations');
      return;
    }
    res.status(200).json({ annotations: [...(days.data ?? []), ...(rest.data ?? [])] });
    return;
  }

  // ── POST { target_kind, target_id, body, severity? } — create ─────────────

  if (method === 'POST') {
    if (!isTargetKind(body.target_kind)) {
      res.status(400).send('Body must carry target_kind: day|event|block');
      return;
    }
    const kind: AnnotationTargetKind = body.target_kind;
    const problem = targetProblem(kind, body.target_id);
    if (problem) {
      res.status(400).send(problem);
      return;
    }
    const note = normalizeBody(body.body);
    if ('reason' in note) {
      res.status(400).send(note.reason);
      return;
    }
    let severity: AnnotationSeverity = 'info';
    if (body.severity !== undefined) {
      if (!isSeverity(body.severity)) {
        res.status(400).send('severity must be info|caution|alert');
        return;
      }
      severity = body.severity;
    }

    const { data, error } = await supabase
      .from('coach_annotations')
      .insert({
        user_id: userId,
        target_kind: kind,
        target_id: body.target_id as string,
        body: note.body,
        severity,
        // Server-stamped: the only writer today is the coach's tool, and a
        // caller that could name the author could forge a reflection.
        created_by: 'coach',
      })
      .select(COLUMNS)
      .single();
    if (error || !data) {
      console.error('[api/coach-annotations] create failed:', error?.message);
      res.status(500).send('Failed to create annotation');
      return;
    }
    res.status(200).json({ annotation: data });
    return;
  }

  // ── DELETE { id } — dismiss ───────────────────────────────────────────────

  const id = typeof body.id === 'string' ? body.id : first(req.query.id as string | string[] | undefined) ?? '';
  if (!UUID_RE.test(id)) {
    res.status(400).send('Invalid annotation id');
    return;
  }
  // A dismiss is idempotent and tells nothing: a second click, or an id from
  // another account, both update zero rows and both answer ok. The first
  // dismissed_at is the one kept — `is null` stops a repeat from re-stamping.
  const { error } = await supabase
    .from('coach_annotations')
    .update({ dismissed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .is('dismissed_at', null);
  if (error) {
    console.error('[api/coach-annotations] dismiss failed:', error.message);
    res.status(500).send('Failed to dismiss annotation');
    return;
  }
  res.status(200).json({ ok: true });
}
