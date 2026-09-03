import Anthropic from '@anthropic-ai/sdk';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser } from './_lib/auth.js';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';
import { getAnthropicKey } from './_lib/anthropicKey.js';
import { enforceRateLimit } from './_lib/rateLimit.js';
import { analyticsToolSchemas, builderToolSchemas, coachToolSchemas } from '../src/lib/coach/schemas.js';
import { resolveCoachModel } from '../src/lib/coach/models.js';
import type { ChatWireEvent } from '../src/lib/coach/wire.js';
import { streamToWireEvents as translate, type UpstreamEvent as Upstream } from './_lib/wire.js';
import { buildChatContext, ChatContextError, isChatMode, type ChatMode } from './_lib/coach/context.js';
import { findCoachTool, type CoachToolContext } from '../src/lib/coach/tools.js';

// Server-side proxy for the coach chat, running on the CALLER'S OWN
// Anthropic key (server-only user_api_keys table — no key ever reaches the
// browser). The client posts { messages, system, withTools } and reads back
// newline-delimited JSON (one ChatWireEvent per line — see
// src/lib/coach/wire.ts). Tool inputs are buffered here and emitted as one
// complete tool_use event per block — simpler for the client than forwarding
// partial JSON deltas. A response with parallel tool calls yields one
// tool_use event per block; the client queues them all (actionQueue.ts).
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
export type { UpstreamEvent, UpstreamUsage } from './_lib/wire.js';

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
// block. Reads bill at ~0.1x input, writes at 1.25x — so a breakpoint whose
// entry can never be read is a pure loss, which drives two rules here:
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
//
// The cache is also keyed per MODEL: switching models in the picker
// invalidates all three tiers, so the first turn afterwards reads nothing and
// pays every write. Expected, and self-correcting on the next turn.
//
// Still uncached by construction: the system block embeds live schedule and
// meal state, so any confirmed mutation invalidates system+messages on the
// next turn. Fixing that means moving the volatile region out of `system` —
// gate it on the usage numbers logged at the end of the handler.

export type ToolMode = ChatMode;

/**
 * Static tool schemas with a cache breakpoint on the last one. Three modes,
 * each with its own CONSTANT list: the sidebar's full registry, the
 * builder's single draft tool, and the analytics builder's single chart
 * tool. A mode's tools+system prefix stays identical across its own turns
 * (the caching rules above hold per mode); a scoped mode's absent
 * calendar/meal tools are what make "the coach can never apply, save, or
 * touch the schedule from here" structural.
 */
export function cachedToolSchemas(mode: ToolMode = 'chat'): Anthropic.Tool[] {
  const tools =
    mode === 'builder' ? builderToolSchemas()
    : mode === 'analytics' ? analyticsToolSchemas()
    : coachToolSchemas();
  return tools.map((tool, i) =>
    i === tools.length - 1 ? { ...tool, cache_control: { type: 'ephemeral' as const } } : tool,
  );
}

/**
 * The messages array with a cache breakpoint on the final content block
 * (string content becomes a single text block). The client always ends the
 * array with a user message — text or tool_results — but any cacheable
 * block shape works.
 */
export function withConversationBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  if (!last) return messages;
  const cache = { cache_control: { type: 'ephemeral' as const } };
  let content: Anthropic.MessageParam['content'];
  if (typeof last.content === 'string') {
    content = [{ type: 'text', text: last.content, ...cache }];
  } else {
    const blocks = last.content;
    if (blocks.length === 0) return messages;
    content = blocks.map((block, i) =>
      i === blocks.length - 1 ? ({ ...block, ...cache } as typeof block) : block,
    );
  }
  return [...messages.slice(0, -1), { ...last, content } as Anthropic.MessageParam];
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

  // The system prompt is built client-side from the caller's own
  // RLS-filtered data, so per-user data scoping is by construction; the
  // verified uid here selects whose Anthropic key pays for the call.
  const userId = await requireUser(req, res);
  if (!userId) return;

  // 429 before any NDJSON headers so the client sees a plain HTTP error.
  if (!(await enforceRateLimit(supabase, res, userId, 'chat'))) return;

  let apiKey: string | null;
  try {
    apiKey = await getAnthropicKey(supabase, userId);
  } catch (err) {
    console.error('[api/chat] key lookup failed:', err instanceof Error ? err.message : err);
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

  // Sanity bounds ~10x above legitimate usage — a request outside them is a
  // bug or abuse, not a long conversation.
  if (body.messages.length > 80 || JSON.stringify(body.messages).length > 400_000) {
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
  let system: string;
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
      ({ system, toolContext } = await buildChatContext(supabase, userId, toolMode, body.today, draft));
    } catch (err) {
      if (err instanceof ChatContextError) {
        res.status(400).send(err.message);
        return;
      }
      console.error('[api/chat] context build failed:', err instanceof Error ? err.message : err);
      res.status(500).send('Failed to build coach context');
      return;
    }
  }

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

  try {
    const client = new Anthropic({ apiKey });
    const stream = client.messages.stream({
      model: coachModel.id,
      // max_tokens caps thinking + response text together on current models.
      // At 1024, planning-heavy requests spent the whole budget on thinking
      // and streamed zero text (stop_reason max_tokens on 14/30 eval cases).
      max_tokens: 8192,
      // Per-model, not a shared literal: `thinking` is absent on models that
      // predate adaptive thinking, which reject it outright (models.ts).
      ...coachModel.params,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      // Constant tool list (per mode) + tool_choice to gate it — see the
      // caching note above.
      tools: cachedToolSchemas(toolMode),
      ...(withTools ? {} : { tool_choice: { type: 'none' as const } }),
      messages: withTools ? withConversationBreakpoint(messages) : messages,
    }, { signal: upstreamAbort.signal });
    const usage = await translate(stream as AsyncIterable<Upstream>, send);
    if (usage) {
      console.log('[api/chat] usage', {
        model: coachModel.id,
        withTools,
        input:      usage.input_tokens ?? 0,
        cacheRead:  usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
        output:     usage.output_tokens ?? 0,
      });
    }
  } catch (err) {
    if (upstreamAbort.signal.aborted) {
      // The client went away — the abort is the intended outcome and there
      // is nobody left to read a wire error.
    } else {
      console.error('[api/chat] stream failed:', err);
      send({ type: 'error', message: 'Chat request failed' });
    }
  }

  finished = true;
  res.end();
}
