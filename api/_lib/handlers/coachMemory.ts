import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';
import { isMemoryKind, MEMORY_CONFIRMED_CAP, MEMORY_CONTENT_MAX, MEMORY_KINDS } from '../../../src/lib/coach/memory.js';
import type { CoachMemoryRow } from '../../../src/lib/db/types.js';

// The coach's memory over HTTP (lane C02): the notebook's door onto the
// coach_memory table. In chat the write path is the confirm card
// (POST /api/coach-tool → applyMemoryCommand); this handler is what a UI
// that shows the athlete their memories — and lets them accept a proposal,
// add a fact by hand, or forget one — talks to.
//
// ROUTING: method plus body shape, no ?op= verb (the coachConversations
// pattern).
//   GET                       → every non-archived memory, newest first,
//                               with `confirmed` (proposed rows have it false)
//   POST   { id }             → confirm a proposed row (confirmed_at = now)
//   POST   { kind, content }  → add one the athlete wrote: confirmed, source 'user'
//   DELETE { id }             → archive (never a hard delete)
// The two POSTs are told apart by a required key the other does not accept.
//
// Every query is scoped with .eq('user_id', userId). The user id comes from
// the JWT via requireUser and never from the body.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The GET's bound: the confirmed cap plus room for proposals awaiting a click. */
const LIST_LIMIT = MEMORY_CONFIRMED_CAP * 2;

const COLUMNS = 'id, kind, content, confidence, source_kind, created_at, confirmed_at';

type Listed = Pick<CoachMemoryRow, 'id' | 'kind' | 'content' | 'confidence' | 'source_kind' | 'created_at' | 'confirmed_at'>;

function withFlag(row: Listed) {
  return { ...row, confirmed: row.confirmed_at !== null };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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

  if (!(await enforceRateLimit(supabase, res, userId, method === 'GET' ? 'reads' : 'writes'))) return;

  const body = (req.body ?? {}) as Record<string, unknown>;

  // ── GET — the notebook's list ─────────────────────────────────────────────

  if (method === 'GET') {
    const { data, error } = await supabase
      .from('coach_memory')
      .select(COLUMNS)
      .eq('user_id', userId)
      .is('archived_at', null)
      .is('superseded_by', null)
      .order('created_at', { ascending: false })
      .limit(LIST_LIMIT);
    if (error) {
      console.error('[api/coach-memory] list failed:', error.message);
      res.status(500).send('Failed to load memory');
      return;
    }
    res.status(200).json({ memories: ((data ?? []) as Listed[]).map(withFlag) });
    return;
  }

  // ── POST { id } — confirm a proposal ──────────────────────────────────────

  if (method === 'POST' && body.id !== undefined) {
    const id = typeof body.id === 'string' ? body.id : '';
    if (!UUID_RE.test(id)) {
      res.status(400).send('Invalid memory id');
      return;
    }
    // Scoped by user_id, so another account's id reads as "not found" rather
    // than as a permission error that confirms it exists. Archived rows stay
    // archived: confirming a forgotten proposal is not a way back in.
    const { data, error } = await supabase
      .from('coach_memory')
      .update({ confirmed_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
      .is('archived_at', null)
      .select(COLUMNS)
      .maybeSingle();
    if (error) {
      console.error('[api/coach-memory] confirm failed:', error.message);
      res.status(500).send('Failed to confirm memory');
      return;
    }
    if (!data) {
      res.status(404).send('Memory not found');
      return;
    }
    res.status(200).json({ memory: withFlag(data as Listed) });
    return;
  }

  // ── POST { kind, content } — the athlete adds a fact ──────────────────────

  if (method === 'POST') {
    if (!isMemoryKind(body.kind)) {
      res.status(400).send(`Body must carry kind: ${MEMORY_KINDS.join('|')}`);
      return;
    }
    const content = typeof body.content === 'string' ? body.content.replace(/\s+/g, ' ').trim() : '';
    if (!content || content.length > MEMORY_CONTENT_MAX) {
      res.status(400).send(`content must be 1–${MEMORY_CONTENT_MAX} characters`);
      return;
    }
    // The cap is the same one the chat path honours; the count is of what
    // renders, so superseded and archived rows never crowd a live one out.
    const live = await supabase
      .from('coach_memory')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .not('confirmed_at', 'is', null)
      .is('archived_at', null)
      .is('superseded_by', null);
    if (live.error) {
      console.error('[api/coach-memory] count failed:', live.error.message);
      res.status(500).send('Failed to save memory');
      return;
    }
    if ((live.count ?? 0) >= MEMORY_CONFIRMED_CAP) {
      res.status(409).send(`Memory is full (${MEMORY_CONFIRMED_CAP} facts) — forget one first`);
      return;
    }
    const { data, error } = await supabase
      .from('coach_memory')
      .insert({ user_id: userId, kind: body.kind, content, source_kind: 'user', confirmed_at: new Date().toISOString() })
      .select(COLUMNS)
      .single();
    if (error || !data) {
      console.error('[api/coach-memory] add failed:', error?.message);
      res.status(500).send('Failed to save memory');
      return;
    }
    res.status(200).json({ memory: withFlag(data as Listed) });
    return;
  }

  // ── DELETE { id } — forget: archive, never remove ─────────────────────────

  const id = typeof body.id === 'string' ? body.id : first(req.query.id as string | string[] | undefined) ?? '';
  if (!UUID_RE.test(id)) {
    res.status(400).send('Invalid memory id');
    return;
  }
  const { error } = await supabase
    .from('coach_memory')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId);
  if (error) {
    console.error('[api/coach-memory] archive failed:', error.message);
    res.status(500).send('Failed to forget memory');
    return;
  }
  res.status(200).json({ ok: true });
}
