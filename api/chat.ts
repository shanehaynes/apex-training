import type Anthropic from '@anthropic-ai/sdk';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser } from './_lib/auth.js';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';
import { getAnthropicKey } from './_lib/anthropicKey.js';
import { makeAnthropicClient } from './_lib/anthropicClient.js';
import { enforceRateLimit } from './_lib/rateLimit.js';
import { clientTag } from './_lib/clientVersion.js';
import { recordCoachRun, type CoachRunInsert } from './_lib/coachRuns.js';
import { reportError } from './_lib/errorReport.js';
import { analyticsToolSchemas, builderToolSchemas, coachToolSchemas } from '../src/lib/coach/schemas.js';
import { resolveCoachModel } from '../src/lib/coach/models.js';
import { PROMPT_VERSION } from '../src/lib/coach/prompt.js';
import type { ChatWireEvent } from '../src/lib/coach/wire.js';
import { streamToWireEvents as translate, type UpstreamEvent as Upstream, type UpstreamUsage } from './_lib/wire.js';
import { buildChatContext, ChatContextError, isChatMode, type ChatMode } from './_lib/coach/context.js';
import { findCoachTool, isServerSideTool, READ_DOCTRINE_TOOL, type CoachToolContext } from '../src/lib/coach/tools.js';
import { executeReadTool, readToolLabel, readToolSchemas } from './_lib/coach/readTools.js';
import { DOCTRINE_TOPICS, readDoctrine, readDoctrineToolSchema } from '../src/lib/coach/doctrine/index.js';

// Server-side proxy for the coach chat, running on the CALLER'S OWN
// Anthropic key (server-only user_api_keys table — no key ever reaches the
// browser). The client posts { messages, system, withTools } and reads back
// newline-delimited JSON (one ChatWireEvent per line — see
// src/lib/coach/wire.ts). Tool inputs are buffered here and emitted as one
// complete tool_use event per block — simpler for the client than forwarding
// partial JSON deltas. A response with parallel tool calls yields one
// tool_use event per block; the client queues them all (actionQueue.ts).
//
// THE SIGHT LOOP (coach initiative, B01). In chat mode the tool list also
// carries the read tools (api/_lib/coach/readTools.ts) and read_doctrine.
// Those never reach the browser as confirm cards: when a response asks only
// for server-side tools, this handler runs them here, appends the assistant
// message (thinking blocks included) and one user message of tool_results,
// and calls upstream again — up to MAX_SERVER_ROUNDS times inside the one
// user turn — narrating each call on the wire as tool_read /
// tool_read_result so the client can show what was checked and store an
// API-valid transcript. A response that also asks for a write tool ends the
// turn as before: the reads are executed and answered on the wire, the
// writes become confirm cards, and the client's tool_result message carries
// both sets of results.
//
// IMPORT SURFACE WARNING: this function once crashed at module load on
// Vercel — an extensionless relative import, which real Node ESM rejects.
// Since W5a the graph deliberately reaches src/lib/coach (prompt builders,
// tool labels) and the draft reducers through api/_lib/coach/context.ts;
// api/__tests__/esm-imports.test.ts walks every reachable file and fails on
// any specifier without a .js extension. Nothing here may import React,
// Supabase-js or the browser API client.

// The stream translator lives in api/_lib/wire.ts (shared with the summary
// handler); re-exported so existing imports and tests keep their paths.
export { streamToWireEvents } from './_lib/wire.js';
export type { UpstreamEvent, UpstreamUsage, StreamOutcome } from './_lib/wire.js';

interface Body {
  messages?: unknown;
  /** LEGACY: a client-built system prompt. Superseded by mode/today/context
   *  (W5a) — accepted until every bundle has switched. */
  system?: unknown;
  withTools?: unknown;
  /** 'chat' | 'builder' | 'analytics' — which prompt and which tool list. */
  mode?: unknown;
  /** @deprecated alias of `mode` from the legacy body. */
  toolMode?: unknown;
  /** The caller's local calendar date, YYYY-MM-DD (v2 bodies). */
  today?: unknown;
  /** builder/analytics: the current draft the server describes in the prompt. */
  context?: { draft?: unknown } | unknown;
  /** Chosen model id; anything unrecognised resolves to the default. */
  model?: unknown;
}

// ─── Prompt caching ──────────────────────────────────────────────────────────
// Caching is a prefix match over tools → system → messages, and each tier is
// invalidated by any change at or before it. Three ephemeral breakpoints
// (max is 4): the last tool schema, the system block, and the last message
// block. Reads bill at ~0.1x input, writes at 1.25x (2x for a 1-hour entry)
// — so a breakpoint whose entry can never be read is a pure loss, which
// drives the rules here:
//
//   1. Tools ship on EVERY request, including the post-confirm re-stream that
//      forbids their use. Adding or removing a tool definition invalidates the
//      tools, system AND messages tiers, so toggling them would split the
//      conversation into two lineages that can never read each other's
//      entries — every re-stream a guaranteed miss that still pays the write.
//      Holding the tool list constant and switching tool_choice instead keeps
//      the tools+system prefix identical across both calls.
//   2. The messages breakpoint is written only on the tools-on turn. Changing
//      tool_choice invalidates the messages tier, so the re-stream's entry has
//      no future reader.
//   3. In chat mode the `system` block is the STABLE half of the prompt only
//      (buildStablePrompt: role, safety, library, rules, style). The live
//      half — today, schedule, meals, block, athlete — used to sit in it too,
//      so any confirmed mutation, meal logged, or new day invalidated
//      system+messages on the next turn and the coach rebuilt the same 2–3k
//      tokens every call. Now that half travels AFTER the cached prefix
//      (injectVolatile below) and only its own bytes change per turn.
//   4. The tools and system breakpoints in chat mode carry a 1-hour TTL: a
//      coaching conversation has gaps of 5–60 minutes between turns, which is
//      exactly the window where the 2x write beats re-paying the whole prefix
//      after the 5-minute default lapses. Entries with the longer TTL must
//      come before shorter ones, so the tools breakpoint takes the same TTL
//      as the system block it precedes; the messages breakpoint stays at 5
//      minutes. Builder and analytics embed the live draft in `system`, so
//      their prefix changes on most turns and a 1-hour entry would rarely be
//      read back — they and the legacy client-built `system` keep the default.
//   5. The server-side tool loop re-sends the SAME tools, system and
//      breakpoints on every round of a turn, and only ever appends after the
//      messages breakpoint (the assistant message and its tool_results), so
//      each continuation reads the whole prefix back. The live context is
//      injected once, on the original last user message, never again: the
//      rounds sit after it (or ahead of the trailing system entry on a
//      mid-turn-system model — appendServerRound).
//
// The cache is also keyed per MODEL: switching models in the picker
// invalidates all three tiers, so the first turn afterwards reads nothing and
// pays every write. Expected, and self-correcting on the next turn.
//
// Where the live half goes decides whether the CONVERSATION tier can hit. On
// a model that accepts a mid-conversation `{ role: 'system' }` message
// (models.ts midTurnSystem), it is appended after the last user message and
// the breakpoint goes on that user message: the client never stores the
// injected entry, so next turn's history is byte-identical up to there and
// reads back. On the other models it becomes a text block inside the last
// user message; the next request rebuilds that message without it, so the
// history tier misses at that point every turn and only tools+system read
// back. Still ahead of embedding the live state in `system`, where a
// mutation cost both tiers — and the flag is a one-word upgrade per model.
// Gate any further change on the usage numbers logged at the end of the
// handler.

export type ToolMode = ChatMode;

/** Breakpoint TTL. '5m' is the API default and is sent as a bare marker. */
export type CacheTtl = '5m' | '1h';

function ephemeral(ttl: CacheTtl): Anthropic.CacheControlEphemeral {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

/**
 * The chat coach's full tool list, in the one fixed order the prompt cache
 * (a prefix match over the tools) needs on every turn: the eight write
 * tools, then the read tools, then read_doctrine. Composed here rather than
 * in schemas.ts because the read schemas come out of the MCP tool
 * implementations, which are server code and stay out of the browser bundle.
 */
export function chatToolSchemas(): Anthropic.Tool[] {
  return [...coachToolSchemas(), ...readToolSchemas(), { ...readDoctrineToolSchema }];
}

/**
 * Static tool schemas with a cache breakpoint on the last one. Three modes,
 * each with its own CONSTANT list: the sidebar's registry plus the read
 * tools, the builder's single draft tool, and the analytics builder's
 * single chart tool. A mode's tools+system prefix stays identical across
 * its own turns (the caching rules above hold per mode); a scoped mode's
 * absent calendar/meal tools are what make "the coach can never apply,
 * save, or touch the schedule from here" structural.
 */
export function cachedToolSchemas(mode: ToolMode = 'chat', ttl: CacheTtl = '5m'): Anthropic.Tool[] {
  const tools =
    mode === 'builder' ? builderToolSchemas()
    : mode === 'analytics' ? analyticsToolSchemas()
    : chatToolSchemas();
  return tools.map((tool, i) =>
    i === tools.length - 1 ? { ...tool, cache_control: ephemeral(ttl) } : tool,
  );
}

// ─── The server-side tool loop ───────────────────────────────────────────────

/** How many times one user turn may answer a server-side tool round and call
 *  upstream again. The sixth request for reads ends the turn with a notice. */
export const MAX_SERVER_ROUNDS = 5;

/**
 * Past this many ms since the handler started, no further round begins —
 * measured after a round's reads have run and been answered, so a late
 * response never triggers one more upstream call: the function's
 * maxDuration is 60 s (vercel.json), a round with thinking runs 5–15 s,
 * and a turn cut off by the platform loses everything it read.
 */
export const ROUND_BUDGET_MS = 40_000;

export const ROUND_LIMIT_NOTICE =
  'The coach stopped after the lookup limit for one message. Ask again to continue from here.';

/** The chip text for a server-side call: the read tool's label, or the doctrine topic. */
export function serverSideToolLabel(name: string, input: unknown): string {
  if (name !== READ_DOCTRINE_TOOL) return readToolLabel(name, input);
  const topic = typeof input === 'object' && input !== null ? (input as { topic?: unknown }).topic : undefined;
  const title = DOCTRINE_TOPICS.find(t => t.id === topic)?.title;
  return `Doctrine: ${title ?? (typeof topic === 'string' && topic ? topic : 'unknown topic')}`;
}

export interface ServerToolOutcome {
  /** What the model is handed — a document block for the doctrine, so the
   *  next answer can cite its lines; the read tool's text otherwise. */
  result: Anthropic.ToolResultBlockParam;
  /** What the wire carries (tool_read_result): the same text, or the topic
   *  text for the doctrine. */
  text: string;
  /** The structured content of `result` when it is not plain text (the
   *  doctrine's document block), so a client that must answer this call
   *  itself — a mixed round, whose results travel with the write results —
   *  hands the model the same citable document, not a flattened string. */
  content?: Exclude<Anthropic.ToolResultBlockParam['content'], string | undefined>;
  isError: boolean;
}

/**
 * Run one server-side tool. Never throws: executeReadTool has that contract,
 * and the doctrine reader answers a bad topic with an error result the model
 * can correct.
 */
export async function runServerSideTool(
  supabase: Parameters<typeof executeReadTool>[0],
  userId: string,
  block: { id: string; name: string; input: unknown },
): Promise<ServerToolOutcome> {
  if (block.name === READ_DOCTRINE_TOOL) {
    const topic = typeof block.input === 'object' && block.input !== null ? (block.input as { topic?: unknown }).topic : undefined;
    const text = typeof topic === 'string' ? readDoctrine(topic) : null;
    if (text === null) {
      const message = `Unknown doctrine topic: ${typeof topic === 'string' ? topic : String(topic)}`;
      return { result: { type: 'tool_result', tool_use_id: block.id, content: message, is_error: true }, text: message, isError: true };
    }
    const title = DOCTRINE_TOPICS.find(t => t.id === topic)?.title ?? (topic as string);
    const content: Anthropic.ToolResultBlockParam['content'] = [{
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: text },
      title,
      citations: { enabled: true },
    }];
    return {
      result: { type: 'tool_result', tool_use_id: block.id, content },
      text,
      content,
      isError: false,
    };
  }
  const { text, isError } = await executeReadTool(supabase, userId, block.name, block.input);
  return {
    result: { type: 'tool_result', tool_use_id: block.id, content: text, ...(isError ? { is_error: true } : {}) },
    text,
    isError,
  };
}

/**
 * The outgoing messages after one server round: the assistant message as
 * the API returned it (thinking blocks and all — the API rejects a
 * continuation that drops them), then one user message holding every
 * tool_result. The live context stays where injectVolatile put it: on the
 * original last user message, or — on a mid-turn-system model — as the
 * trailing `system` entry, which must remain last, so the round goes in
 * ahead of it.
 */
export function appendServerRound(
  messages: Anthropic.MessageParam[],
  assistantContent: Anthropic.ContentBlockParam[],
  results: Anthropic.ToolResultBlockParam[],
): Anthropic.MessageParam[] {
  const round: Anthropic.MessageParam[] = [
    { role: 'assistant', content: assistantContent },
    { role: 'user', content: results },
  ];
  const last = messages[messages.length - 1];
  if (last && last.role === 'system') return [...messages.slice(0, -1), ...round, last];
  return [...messages, ...round];
}

function addUsage(total: UpstreamUsage | null, round: UpstreamUsage | null): UpstreamUsage | null {
  if (!round) return total;
  if (!total) return { ...round };
  const sum = (key: keyof UpstreamUsage) => (total[key] ?? 0) + (round[key] ?? 0);
  return {
    input_tokens: sum('input_tokens'),
    output_tokens: sum('output_tokens'),
    cache_creation_input_tokens: sum('cache_creation_input_tokens'),
    cache_read_input_tokens: sum('cache_read_input_tokens'),
  };
}

/**
 * The outgoing messages with this turn's live context added — to a COPY, so
 * the caller's array (which mirrors what the client stores) is never
 * touched and the injected text never round-trips into the thread.
 *
 * - `volatile` empty (builder, analytics, the legacy path): unchanged.
 * - `midTurnSystem`: appended as `{ role: 'system', content }` after the last
 *   message — the API's operator channel, which must follow a user message
 *   and be the final entry.
 * - otherwise: a text block inside the last user message. It goes first when
 *   that message is a string or opens with text; when the message carries
 *   tool_result blocks the API requires those to lead, so it goes right
 *   after the last of them and ahead of any text that follows.
 */
export function injectVolatile(
  messages: Anthropic.MessageParam[],
  volatile: string,
  midTurnSystem: boolean,
): Anthropic.MessageParam[] {
  if (!volatile) return messages;
  if (midTurnSystem) return [...messages, { role: 'system', content: volatile }];

  const at = lastIndexOfRole(messages, 'user');
  if (at < 0) return messages;
  const target = messages[at];
  const block: Anthropic.TextBlockParam = { type: 'text', text: volatile };
  let content: Anthropic.ContentBlockParam[];
  if (typeof target.content === 'string') {
    // An empty text block is a 400, so an empty string yields the block alone.
    content = target.content ? [block, { type: 'text', text: target.content }] : [block];
  } else {
    const blocks = target.content;
    let after = 0;
    while (after < blocks.length && blocks[after].type === 'tool_result') after++;
    content = [...blocks.slice(0, after), block, ...blocks.slice(after)];
  }
  return [...messages.slice(0, at), { ...target, content }, ...messages.slice(at + 1)];
}

function lastIndexOfRole(messages: Anthropic.MessageParam[], role: Anthropic.MessageParam['role']): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === role) return i;
  }
  return -1;
}

/**
 * The messages array with a cache breakpoint on the final content block of
 * the final message (string content becomes a single text block). The
 * client always ends the array with a user message — text or tool_results —
 * but any cacheable block shape works. When injectVolatile has appended a
 * `system` entry, the breakpoint goes on the last USER message instead: the
 * injected entry is regenerated every turn and never stored, so an entry
 * ending on it would have no future reader, while one ending on the user
 * message is exactly the prefix next turn resends.
 */
export function withConversationBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  let at = messages.length - 1;
  if (at < 0) return messages;
  if (messages[at].role === 'system') {
    at = lastIndexOfRole(messages, 'user');
    if (at < 0) return messages;
  }
  const target = messages[at];
  const cache = { cache_control: ephemeral('5m') };
  let content: Anthropic.MessageParam['content'];
  if (typeof target.content === 'string') {
    content = [{ type: 'text', text: target.content, ...cache }];
  } else {
    const blocks = target.content;
    if (blocks.length === 0) return messages;
    content = blocks.map((block, i) =>
      i === blocks.length - 1 ? ({ ...block, ...cache } as typeof block) : block,
    );
  }
  return [...messages.slice(0, at), { ...target, content } as Anthropic.MessageParam, ...messages.slice(at + 1)];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  // One id for this turn: it tags every log line below, goes back on the
  // response as x-apex-request-id, and is the coach_runs column that lines a
  // stored row up with whatever the Vercel function log still holds.
  const requestId = crypto.randomUUID();

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  // The verified uid scopes everything below: the prompt is built from this
  // user's own rows (buildChatContext), and the uid selects whose Anthropic
  // key pays for the call.
  const userId = await requireUser(req, res);
  if (!userId) return;

  // 429 before any NDJSON headers so the client sees a plain HTTP error.
  if (!(await enforceRateLimit(supabase, res, userId, 'chat'))) return;

  let apiKey: string | null;
  try {
    apiKey = await getAnthropicKey(supabase, userId);
  } catch (err) {
    console.error('[api/chat] key lookup failed:', requestId, err instanceof Error ? err.message : err);
    res.status(500).send('Failed to load API key');
    return;
  }
  // 402 before any NDJSON headers — the client reads this as a plain HTTP
  // error and shows the add-your-key setup prompt.
  if (!apiKey) {
    res.status(402).send('anthropic-key-missing');
    return;
  }

  const body = req.body as Body | undefined;
  if (!Array.isArray(body?.messages)) {
    res.status(400).send('Missing messages');
    return;
  }

  // Sanity bounds well above legitimate usage — a request outside them is a
  // bug or abuse, not a long conversation. The count was 80 before the sight
  // loop; a turn that reads twice now stores two assistant/user pairs on top
  // of its own, so the same conversation trips a count bound about three
  // times sooner. 160 keeps the ~10x headroom the old bound had. The byte
  // cap is unchanged — read results are the bytes that grow, and 400 KB is
  // still far past any real thread. The real fix is context editing /
  // compaction of old tool results, not a higher number (FOLLOW-UPS).
  if (body.messages.length > 160 || JSON.stringify(body.messages).length > 400_000) {
    res.status(413).send('Conversation too large');
    return;
  }
  for (const msg of body.messages as Array<{ role?: unknown }>) {
    if (msg?.role !== 'user' && msg?.role !== 'assistant') {
      res.status(400).send('Invalid message role');
      return;
    }
  }

  const modeInput = body.mode ?? body.toolMode;
  const toolMode: ChatMode = isChatMode(modeInput) ? modeInput : 'chat';

  // The system prompt: built here from the caller's own data (v2), or
  // handed over by a legacy bundle. Either way the verified uid scopes it.
  // `volatile` is chat mode's live half, injected per request below; it
  // stays '' for the other modes and the legacy path, which keep one block.
  let system: string;
  let volatile = '';
  let toolContext: CoachToolContext | null = null;
  if (typeof body.system === 'string') {
    if (body.system.length > 100_000) {
      res.status(413).send('System prompt too large');
      return;
    }
    system = body.system;
  } else {
    const draft = typeof body.context === 'object' && body.context !== null
      ? (body.context as { draft?: unknown }).draft
      : undefined;
    try {
      ({ system, volatile, toolContext } = await buildChatContext(supabase, userId, toolMode, body.today, draft));
    } catch (err) {
      if (err instanceof ChatContextError) {
        res.status(400).send(err.message);
        return;
      }
      console.error('[api/chat] context build failed:', requestId, err instanceof Error ? err.message : err);
      res.status(500).send('Failed to build coach context');
      return;
    }
  }

  // Deliberately set HERE, not at the top of the handler: everything above
  // this line is a plain HTTP error (402/413/429) that must reach the client
  // with no headers of ours on it, which is what chat.test.ts pins.
  res.setHeader('x-apex-request-id', requestId);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  // tool_use events carry the confirmation-card label, computed with the
  // context the prompt was built from (W5a) so a native client never ports
  // displayLabel. Best-effort: a label failure must not break the stream.
  const send = (event: ChatWireEvent) => {
    let out = event;
    if (event.type === 'tool_use' && toolContext) {
      try {
        const label = findCoachTool(event.name)?.displayLabel(event.input, toolContext);
        if (label) out = { ...event, label };
      } catch { /* the client falls back to the tool name */ }
    }
    res.write(JSON.stringify(out) + '\n');
  };

  // Abort propagation: when the browser cancels the fetch (the Stop button,
  // or a closed tab), the socket dies but the upstream Anthropic request
  // would otherwise run — and bill — to completion. res 'close' fires on
  // premature disconnect AND after a normal end, so the finished flag keeps
  // the normal path from aborting a stream that already completed.
  const upstreamAbort = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) upstreamAbort.abort(); });

  const withTools = !!body.withTools;
  const messages = body.messages as Anthropic.MessageParam[];
  // Allowlisted, never trusted verbatim: an arbitrary id would be paired
  // with the wrong thinking config (Haiku 4.5 400s on adaptive thinking).
  // The bill is the caller's own key either way.
  const coachModel = resolveCoachModel(body.model);

  // Everything a coach_runs row needs that is known before the call; the
  // measured half is merged in at each exit below.
  const runBase = {
    user_id: userId,
    request_id: requestId,
    mode: toolMode,
    model: coachModel.id,
    prompt_version: PROMPT_VERSION,
    // Which build produced this traffic (clientVersion.ts). 'web' when there
    // is no tag, whose bundle always matches the deployment serving it.
    client: clientTag(req) ?? 'web',
    with_tools: withTools,
  } satisfies Partial<CoachRunInsert>;

  // A 1-hour prefix only where the prefix is stable enough to be read back an
  // hour later — the split chat prompt (caching rule 4 above). A non-empty
  // `volatile` is exactly the sign that the live state has left `system`.
  const prefixTtl: CacheTtl = volatile ? '1h' : '5m';
  // Inject first, then place the breakpoint: the breakpoint must land on the
  // final block the next turn will resend, which injectVolatile decides.
  const outgoing = injectVolatile(messages, volatile, coachModel.midTurnSystem);

  const startedAt = Date.now();
  try {
    const client = makeAnthropicClient(apiKey);
    // Everything but `messages` is identical on every round of the turn —
    // same system, same tools, same tool_choice — so the tools+system prefix
    // reads back from cache on each continuation.
    const request = {
      model: coachModel.id,
      // max_tokens caps thinking + response text together on current models.
      // At 1024, planning-heavy requests spent the whole budget on thinking
      // and streamed zero text (stop_reason max_tokens on 14/30 eval cases).
      max_tokens: 8192,
      // Per-model, not a shared literal: `thinking` is absent on models that
      // predate adaptive thinking, which reject it outright (models.ts).
      ...coachModel.params,
      system: [{ type: 'text' as const, text: system, cache_control: ephemeral(prefixTtl) }],
      // Constant tool list (per mode) + tool_choice to gate it — see the
      // caching note above.
      tools: cachedToolSchemas(toolMode, prefixTtl),
      ...(withTools ? {} : { tool_choice: { type: 'none' as const } }),
    };
    // The messages breakpoint lands once, on the original last user message
    // (or the last user message ahead of the injected system entry); the
    // rounds appended below carry none, so the breakpoints never move.
    let messagesOut = withTools ? withConversationBreakpoint(outgoing) : outgoing;

    // Only chat mode offers server-side tools; the other modes stream one
    // response as they always did.
    const serverLoop = toolMode === 'chat';
    let usage: UpstreamUsage | null = null;
    let stopReason: string | null = null;
    let toolUseCount = 0;
    let rounds = 0;

    for (;;) {
      const stream = client.messages.stream({ ...request, messages: messagesOut }, { signal: upstreamAbort.signal });
      const outcome = await translate(stream as AsyncIterable<Upstream>, send, { deferToolUse: serverLoop, done: false });
      usage = addUsage(usage, outcome.usage);
      stopReason = outcome.stopReason;
      toolUseCount += outcome.toolUseCount;
      if (!serverLoop) break;

      const toolBlocks = outcome.content.filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use');
      const reads = toolBlocks.filter(b => isServerSideTool(b.name));
      const writes = toolBlocks.filter(b => !isServerSideTool(b.name));
      const emitWrites = () => {
        for (const w of writes) send({ type: 'tool_use', id: w.id, name: w.name, input: w.input as Record<string, unknown> });
      };
      if (reads.length === 0) {
        emitWrites();
        break;
      }
      // Reads that would continue the loop are bounded by the round cap;
      // reads alongside a write end the turn anyway (the client finishes
      // it), so they always run — a refused read there would leave its
      // tool_use unanswered.
      const continues = writes.length === 0;
      const stopLoop = (why: string) => {
        console.warn('[api/chat] server tool loop stopped:', requestId, { why, rounds, elapsedMs: Date.now() - startedAt });
        send({ type: 'notice', message: ROUND_LIMIT_NOTICE });
      };
      if (continues && rounds >= MAX_SERVER_ROUNDS) {
        stopLoop('round cap');
        break;
      }

      for (const r of reads) {
        send({ type: 'tool_read', id: r.id, name: r.name, input: r.input as Record<string, unknown>, label: serverSideToolLabel(r.name, r.input) });
      }
      const outcomes = await Promise.all(reads.map(r => runServerSideTool(supabase, userId, r)));
      outcomes.forEach((o, i) => send({
        type: 'tool_read_result', id: reads[i].id, text: o.text, isError: o.isError,
        ...(o.content ? { content: o.content } : {}),
      }));

      if (!continues) {
        // Mixed: the confirm flow supplies the writes' results, and the
        // client folds these read results into the same tool_result message.
        emitWrites();
        break;
      }
      rounds += 1;
      // The time budget is checked AFTER the reads ran, not before: the reads
      // are cheap and already narrated, so answering them costs nothing and
      // leaves the stored history valid, whereas starting one more upstream
      // request past the budget is what runs into maxDuration.
      if (Date.now() - startedAt > ROUND_BUDGET_MS) {
        stopLoop('time budget');
        break;
      }
      messagesOut = appendServerRound(messagesOut, outcome.content, outcomes.map(o => o.result));
    }
    send({ type: 'done' });

    // The stored row is the queryable record; this line stays because the
    // Vercel log is the real-time view, and the one thing a row cannot be is
    // read while the request is still in flight.
    if (usage) {
      console.log('[api/chat] usage', {
        requestId,
        model: coachModel.id,
        promptVersion: PROMPT_VERSION,
        client: runBase.client,
        withTools,
        rounds,
        input:      usage.input_tokens ?? 0,
        cacheRead:  usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
        output:     usage.output_tokens ?? 0,
      });
    }
    // Awaited, not fire-and-forget: a Vercel function may be frozen the
    // moment res.end() returns, which would drop an in-flight insert. The
    // helper never throws and never rejects (coachRuns.ts), so the await
    // costs one round trip and can only lose a data point, never the turn.
    await recordCoachRun(supabase, {
      ...runBase,
      input_tokens:       usage?.input_tokens ?? 0,
      cache_read_tokens:  usage?.cache_read_input_tokens ?? 0,
      cache_write_tokens: usage?.cache_creation_input_tokens ?? 0,
      output_tokens:      usage?.output_tokens ?? 0,
      tool_use_count:     toolUseCount,
      stop_reason:        stopReason,
      latency_ms:         Date.now() - startedAt,
    });
  } catch (err) {
    // A failed turn is the row worth having most: zeros for the counts it
    // never got, the elapsed time it did, and the reason. Message only —
    // never a stack, never key material (the migration's header).
    const failed = {
      ...runBase,
      input_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 0,
      tool_use_count: 0,
      stop_reason: null,
      latency_ms: Date.now() - startedAt,
    };
    if (upstreamAbort.signal.aborted) {
      // The client went away — the abort is the intended outcome and there
      // is nobody left to read a wire error. The row still gets written:
      // "how often does a user stop the coach mid-answer" is a question only
      // this branch can answer.
      await recordCoachRun(supabase, { ...failed, error: 'client aborted' });
    } else {
      console.error('[api/chat] stream failed:', requestId, err);
      // The one seam every unhandled API error passes through
      // (errorReport.ts). This route never reaches app.ts's bridge — it is
      // its own function — so it reports for itself.
      await reportError(err, { route: '/api/chat', method: 'POST' });
      send({ type: 'error', message: 'Chat request failed' });
      await recordCoachRun(supabase, {
        ...failed,
        // Capped: an SDK error can carry a whole upstream response body in
        // its message, and the column promises "an error message", not a
        // payload. 500 chars is past where any of these stop being readable.
        error: String(err instanceof Error ? err.message : err).slice(0, 500),
      });
    }
  }

  finished = true;
  res.end();
}
