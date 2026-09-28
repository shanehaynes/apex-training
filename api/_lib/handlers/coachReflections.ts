import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';
import { applyContractEdit } from '../reflection/contract.js';
import { isReflectionResolution, REFLECTION_RESOLUTIONS } from '../../../src/lib/coach/contract.js';
import type { CoachReflectionRow } from '../../../src/lib/db/types.js';

// The nightly reflections over HTTP (lane D01): the notebook's door onto the
// coach_reflections table. The cron writes the rows; this is where the
// athlete sees a finished reflection's contract proposal and accepts or
// rejects it. Memory proposals are confirmed one by one through the
// existing /api/coach-memory POST { id }.
//
// ROUTING: method plus body shape, no ?op= verb (the coachConversations
// pattern).
//   GET                                  → finished reflections, the ones
//                                          still waiting on a click first,
//                                          newest first, at most LIST_LIMIT
//   POST { id, resolution }              → 'accepted' writes contract_after
//                                          into profiles.coach_contract and
//                                          stamps the row; 'rejected' stamps
//                                          only. Either is final: a second
//                                          POST on the same row is a 409.
//
// Every query is scoped with .eq('user_id', userId). The user id comes from
// the JWT via requireUser and never from the body.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The GET's bound: a month of nights is plenty for a notebook page. */
export const LIST_LIMIT = 30;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const method = req.method ?? 'GET';
  if (!['GET', 'POST'].includes(method)) {
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

  if (!(await enforceRateLimit(supabase, res, userId, method === 'GET' ? 'reads' : 'writes'))) return;

  // ── GET — the notebook's list ─────────────────────────────────────────────

  if (method === 'GET') {
    // PostgREST sorts nulls first on an ascending order by default, which
    // is exactly "unresolved first"; the tie-break is the day, newest first.
    const { data, error } = await supabase
      .from('coach_reflections')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'done')
      .order('resolved_at', { ascending: true, nullsFirst: true })
      .order('day', { ascending: false })
      .limit(LIST_LIMIT);
    if (error) {
      console.error('[api/coach-reflections] list failed:', error.message);
      res.status(500).send('Failed to load reflections');
      return;
    }
    res.status(200).json({ reflections: (data ?? []) as CoachReflectionRow[] });
    return;
  }

  // ── POST { id, resolution } — accept or reject the contract edit ─────────

  const body = (req.body ?? {}) as Record<string, unknown>;
  const id = typeof body.id === 'string' ? body.id : '';
  if (!UUID_RE.test(id)) {
    res.status(400).send('Invalid reflection id');
    return;
  }
  if (!isReflectionResolution(body.resolution)) {
    res.status(400).send(`resolution must be ${REFLECTION_RESOLUTIONS.join('|')}`);
    return;
  }
  const resolution = body.resolution;

  // Scoped by user_id, so another account's id reads as "not found" rather
  // than as a permission error that confirms it exists.
  const { data: found, error: findError } = await supabase
    .from('coach_reflections')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  if (findError) {
    console.error('[api/coach-reflections] lookup failed:', findError.message);
    res.status(500).send('Failed to resolve reflection');
    return;
  }
  const row = found as CoachReflectionRow | null;
  if (!row) {
    res.status(404).send('Reflection not found');
    return;
  }
  if (row.status !== 'done' || row.contract_after === null) {
    res.status(409).send('This reflection proposed no contract edit');
    return;
  }
  if (row.resolved_at !== null) {
    res.status(409).send(`Already ${row.resolution ?? 'resolved'}`);
    return;
  }

  if (resolution === 'accepted') {
    // The write checks that the contract still reads as the proposal's
    // "before": an edit the athlete made in the notebook since the night
    // the proposal was written must not be overwritten by a stale accept.
    const written = await applyContractEdit(supabase, userId, row.contract_before ?? '', row.contract_after);
    if (!written.ok) {
      res.status(409).send(written.reason);
      return;
    }
  }

  // Conditional on resolved_at still being null, so two clicks — or two tabs
  // — leave one resolution rather than the last one to land.
  const { data, error } = await supabase
    .from('coach_reflections')
    .update({ resolved_at: new Date().toISOString(), resolution })
    .eq('id', id)
    .eq('user_id', userId)
    .is('resolved_at', null)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('[api/coach-reflections] resolve failed:', error.message);
    res.status(500).send('Failed to resolve reflection');
    return;
  }
  if (!data) {
    res.status(409).send('Already resolved');
    return;
  }
  res.status(200).json({ reflection: data as CoachReflectionRow });
}
