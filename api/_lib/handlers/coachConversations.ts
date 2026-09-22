import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';
import type { Json } from '../../../src/lib/db/types.js';

// Server-side coach thread persistence (docs/ios/decisions.md D-013). The web
// thread lived in React state and died with the tab; these six operations are
// the storage behind it, over the phase46 coach_conversations /
// coach_messages tables.
//
// The operation set is deliberately the ConversationStore protocol iOS
// already implements against GRDB
// (ios/Packages/ApexCore/Sources/ApexCore/Coach/ConversationStore.swift), so
// the later iOS move is a sync rather than a second design.
//
// ROUTING: method plus body/query shape, no ?op= verb.
//   GET    ?mode=chat            → list this user's threads for one surface
//   GET    ?id=<uuid>            → load one thread's messages, in order
//   POST   { mode, title? }      → create a thread
//   POST   { id, messages: [] }  → append a batch and bump updated_at
//   PATCH  { id, title }         → rename
//   DELETE { id }                → delete (messages cascade)
// The two GETs and the two POSTs are told apart by a required key that the
// other operation does not accept, so the one ambiguity — a misspelled key —
// lands on a 400 rather than on the wrong operation. An ?op= verb would be a
// second thing to keep in sync with the method for no gain.
//
// Every query is scoped with .eq('user_id', userId). The user id comes from
// the JWT via requireUser and never from the body or the query.

/** Newest threads returned by a list. A sidebar picker, not an archive. */
const LIST_LIMIT = 20;

/**
 * Per-conversation caps, matching api/chat.ts:179 exactly. A thread that grew
 * past them would be stored happily and then 413 on its next turn — the cap
 * belongs where the growth happens, so a client learns at save time rather
 * than at send time. D-025's `historyWindow` is the client-side half of this.
 */
const MAX_MESSAGES = 80;
const MAX_BATCH_BYTES = 400_000;

const ROLES = new Set(['user', 'assistant']);
const KINDS = new Set(['turn', 'notice', 'stopped']);
const MODES = new Set(['chat', 'builder', 'analytics']);
const MAX_TITLE_LENGTH = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One stored message as the API accepts and returns it. */
export interface CoachMessagePayload {
  id?: string;
  role: 'user' | 'assistant';
  /** Verbatim Anthropic content; null on a display-only row (D-025). Typed
   *  as the generated `Json` because that is what the jsonb column takes —
   *  and what a value parsed out of a JSON request body already is. */
  api_content: Json | null;
  /** What the thread renders; null on a hidden row (the briefing prompt). */
  display_text: string | null;
  kind: 'turn' | 'notice' | 'stopped';
  created_at?: string;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Validate an inbound message batch. Returns the rows ready to insert, or a
 * reason string — the caller decides the status code, because "too large" is
 * a 413 and "malformed" is a 400.
 */
function parseMessages(input: unknown): { rows: CoachMessagePayload[] } | { reason: string } {
  if (!Array.isArray(input) || input.length === 0) return { reason: 'messages must be a non-empty array' };
  const rows: CoachMessagePayload[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return { reason: 'each message must be an object' };
    const m = raw as Record<string, unknown>;
    if (typeof m.role !== 'string' || !ROLES.has(m.role)) return { reason: 'invalid message role' };
    const kind = m.kind === undefined ? 'turn' : m.kind;
    if (typeof kind !== 'string' || !KINDS.has(kind)) return { reason: 'invalid message kind' };
    const displayText = m.display_text === undefined ? null : m.display_text;
    if (displayText !== null && typeof displayText !== 'string') return { reason: 'invalid display_text' };
    const apiContent = m.api_content === undefined ? null : m.api_content;
    // Both halves null is a row nothing can render and nothing can replay.
    if (apiContent === null && displayText === null) return { reason: 'message has neither api_content nor display_text' };
    rows.push({
      role: m.role as 'user' | 'assistant',
      // Sound by construction: req.body is the parsed JSON request body, so
      // every value reachable in it is already a Json.
      api_content: apiContent as Json | null,
      display_text: displayText as string | null,
      kind: kind as 'turn' | 'notice' | 'stopped',
    });
  }
  return { rows };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const method = req.method ?? 'GET';
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) {
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

  if (!(await enforceRateLimit(supabase, res, userId, 'conversations'))) return;

  const body = (req.body ?? {}) as Record<string, unknown>;

  // ── GET ?id= — one thread's messages, oldest first ────────────────────────

  if (method === 'GET') {
    const id = first(req.query.id as string | string[] | undefined);
    if (id) {
      if (!UUID_RE.test(id)) {
        res.status(400).send('Invalid conversation id');
        return;
      }
      // Scoped by user_id, so another account's id reads as "not found"
      // rather than as a permission error that confirms it exists.
      const conversation = await supabase
        .from('coach_conversations')
        .select('id, mode, title, created_at, updated_at')
        .eq('id', id)
        .eq('user_id', userId)
        .maybeSingle();
      if (conversation.error) {
        console.error('[api/coach-conversations] load failed:', conversation.error.message);
        res.status(500).send('Failed to load conversation');
        return;
      }
      if (!conversation.data) {
        res.status(404).send('Conversation not found');
        return;
      }
      const messages = await supabase
        .from('coach_messages')
        .select('id, role, api_content, display_text, kind, created_at')
        .eq('conversation_id', id)
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
        .limit(MAX_MESSAGES);
      if (messages.error) {
        console.error('[api/coach-conversations] message load failed:', messages.error.message);
        res.status(500).send('Failed to load conversation');
        return;
      }
      res.status(200).json({ conversation: conversation.data, messages: messages.data ?? [] });
      return;
    }

    // ── GET ?mode= — the thread list for one surface ────────────────────────

    const mode = first(req.query.mode as string | string[] | undefined);
    if (!mode || !MODES.has(mode)) {
      res.status(400).send('Query must carry ?mode=chat|builder|analytics or ?id=<uuid>');
      return;
    }
    const { data, error } = await supabase
      .from('coach_conversations')
      .select('id, mode, title, created_at, updated_at')
      .eq('user_id', userId)
      .eq('mode', mode)
      .order('updated_at', { ascending: false })
      .limit(LIST_LIMIT);
    if (error) {
      console.error('[api/coach-conversations] list failed:', error.message);
      res.status(500).send('Failed to list conversations');
      return;
    }
    res.status(200).json({ conversations: data ?? [] });
    return;
  }

  // ── POST { id, messages } — append a batch, bump updated_at ───────────────

  if (method === 'POST' && body.messages !== undefined) {
    const id = typeof body.id === 'string' ? body.id : '';
    if (!UUID_RE.test(id)) {
      res.status(400).send('Invalid conversation id');
      return;
    }
    const parsed = parseMessages(body.messages);
    if ('reason' in parsed) {
      res.status(400).send(parsed.reason);
      return;
    }
    if (JSON.stringify(parsed.rows).length > MAX_BATCH_BYTES) {
      res.status(413).send('Conversation too large');
      return;
    }

    const owned = await supabase
      .from('coach_conversations')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();
    if (owned.error) {
      console.error('[api/coach-conversations] append ownership check failed:', owned.error.message);
      res.status(500).send('Failed to append messages');
      return;
    }
    if (!owned.data) {
      res.status(404).send('Conversation not found');
      return;
    }

    const existing = await supabase
      .from('coach_messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', id)
      .eq('user_id', userId);
    if (existing.error) {
      console.error('[api/coach-conversations] append count failed:', existing.error.message);
      res.status(500).send('Failed to append messages');
      return;
    }
    if ((existing.count ?? 0) + parsed.rows.length > MAX_MESSAGES) {
      res.status(413).send('Conversation too large');
      return;
    }

    const inserted = await supabase
      .from('coach_messages')
      .insert(parsed.rows.map(m => ({
        conversation_id: id,
        user_id: userId,
        role: m.role,
        api_content: m.api_content ?? null,
        display_text: m.display_text,
        kind: m.kind,
      })))
      .select('id, role, api_content, display_text, kind, created_at');
    if (inserted.error) {
      console.error('[api/coach-conversations] append failed:', inserted.error.message);
      res.status(500).send('Failed to append messages');
      return;
    }

    // The list's sort key is "when I last spoke here", so every append moves
    // the thread to the top. A failure here is logged and not fatal: the
    // messages are stored, and a stale ordering is not worth losing them to.
    const bumped = await supabase
      .from('coach_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId);
    if (bumped.error) console.error('[api/coach-conversations] updated_at bump failed:', bumped.error.message);

    res.status(200).json({ ok: true, messages: inserted.data ?? [] });
    return;
  }

  // ── POST { mode, title? } — create a thread ───────────────────────────────

  if (method === 'POST') {
    const mode = typeof body.mode === 'string' ? body.mode : '';
    if (!MODES.has(mode)) {
      res.status(400).send('Body must carry mode: chat|builder|analytics');
      return;
    }
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, MAX_TITLE_LENGTH) : null;
    const { data, error } = await supabase
      .from('coach_conversations')
      .insert({ user_id: userId, mode, title: title || null })
      .select('id, mode, title, created_at, updated_at')
      .single();
    if (error || !data) {
      console.error('[api/coach-conversations] create failed:', error?.message);
      res.status(500).send('Failed to create conversation');
      return;
    }
    res.status(200).json({ conversation: data });
    return;
  }

  // ── PATCH { id, title } — rename ──────────────────────────────────────────

  if (method === 'PATCH') {
    const id = typeof body.id === 'string' ? body.id : '';
    if (!UUID_RE.test(id)) {
      res.status(400).send('Invalid conversation id');
      return;
    }
    if (typeof body.title !== 'string') {
      res.status(400).send('Body must carry title');
      return;
    }
    const title = body.title.trim().slice(0, MAX_TITLE_LENGTH);
    const { data, error } = await supabase
      .from('coach_conversations')
      .update({ title: title || null })
      .eq('id', id)
      .eq('user_id', userId)
      .select('id, mode, title, created_at, updated_at')
      .maybeSingle();
    if (error) {
      console.error('[api/coach-conversations] rename failed:', error.message);
      res.status(500).send('Failed to rename conversation');
      return;
    }
    if (!data) {
      res.status(404).send('Conversation not found');
      return;
    }
    res.status(200).json({ conversation: data });
    return;
  }

  // ── DELETE { id } — drop a thread; messages cascade ───────────────────────

  const id = typeof body.id === 'string' ? body.id : first(req.query.id as string | string[] | undefined) ?? '';
  if (!UUID_RE.test(id)) {
    res.status(400).send('Invalid conversation id');
    return;
  }
  const { error } = await supabase
    .from('coach_conversations')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);
  if (error) {
    console.error('[api/coach-conversations] delete failed:', error.message);
    res.status(500).send('Failed to delete conversation');
    return;
  }
  res.status(200).json({ ok: true });
}
