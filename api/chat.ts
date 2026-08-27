import Anthropic from '@anthropic-ai/sdk';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser } from './_lib/auth.js';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';
import { getAnthropicKey } from './_lib/anthropicKey.js';
import { enforceRateLimit } from './_lib/rateLimit.js';
import { builderToolSchemas, coachToolSchemas } from '../src/lib/coach/schemas.js';
import { COACH_MODEL } from '../src/lib/coach/model.js';
import type { ChatWireEvent } from '../src/lib/coach/wire.js';

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
// Vercel when it imported the coach executor graph. Only api/_lib and the
// dependency-free src/lib/coach/schemas.ts may be imported here.

/** Token counters we care about — cache hit/miss is the only way to tell
 *  whether the breakpoints below are actually earning their write premium. */
export interface UpstreamUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// Structural subset of the SDK's MessageStreamEvent — keeps the translator
// testable with plain objects.
export interface UpstreamEvent {
  type: string;
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type: string; text?: string; partial_json?: string };
  /** message_start carries the input + cache counters. */
  message?: { usage?: UpstreamUsage };
  /** message_delta carries the running output count. */
  usage?: UpstreamUsage;
}

/**
 * Translate the Anthropic event stream into the NDJSON wire events. Returns
 * the merged usage from message_start/message_delta (null if the stream
 * carried none) so the handler can log cache effectiveness.
 */
export async function streamToWireEvents(
  stream: AsyncIterable<UpstreamEvent>,
  emit: (event: ChatWireEvent) => void,
): Promise<UpstreamUsage | null> {
  let currentTool: { id: string; name: string; json: string } | null = null;
  let usage: UpstreamUsage | null = null;

  for await (const event of stream) {
    const eventUsage = event.type === 'message_start' ? event.message?.usage : event.usage;
    if (eventUsage) usage = { ...(usage ?? {}), ...eventUsage };

    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      currentTool = { id: event.content_block.id ?? '', name: event.content_block.name ?? '', json: '' };
    } else if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta' && event.delta.text) {
        emit({ type: 'text', delta: event.delta.text });
      } else if (event.delta?.type === 'input_json_delta' && currentTool) {
        currentTool.json += event.delta.partial_json ?? '';
      }
    } else if (event.type === 'content_block_stop' && currentTool) {
      emit({
        type: 'tool_use',
        id: currentTool.id,
        name: currentTool.name,
        input: JSON.parse(currentTool.json || '{}') as Record<string, unknown>,
      });
      currentTool = null;
    }
  }

  emit({ type: 'done' });
  return usage;
}

interface Body {
  messages?: unknown;
  system?: unknown;
  withTools?: unknown;
  /** 'builder' = the workout builder's draft-only tool list (see below). */
  toolMode?: unknown;
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
// Still uncached by construction: the system block embeds live schedule and
// meal state, so any confirmed mutation invalidates system+messages on the
// next turn. Fixing that means moving the volatile region out of `system` —
// gate it on the usage numbers logged at the end of the handler.

export type ToolMode = 'chat' | 'builder';

/**
 * Static tool schemas with a cache breakpoint on the last one. Two modes,
 * each with its own CONSTANT list: the sidebar's full registry, and the
 * builder's single draft tool. A mode's tools+system prefix stays identical
 * across its own turns (the caching rules above hold per mode); the builder
 * mode's absent calendar/meal tools are what make "the coach can never
 * apply, save, or touch the schedule from the builder" structural.
 */
export function cachedToolSchemas(mode: ToolMode = 'chat'): Anthropic.Tool[] {
  const tools = mode === 'builder' ? builderToolSchemas() : coachToolSchemas();
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
  if (!Array.isArray(body?.messages) || typeof body.system !== 'string') {
    res.status(400).send('Missing messages or system');
    return;
  }

  // Sanity bounds ~10x above legitimate usage — a request outside them is a
  // bug or abuse, not a long conversation.
  if (body.system.length > 100_000) {
    res.status(413).send('System prompt too large');
    return;
  }
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

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  const send = (event: ChatWireEvent) => { res.write(JSON.stringify(event) + '\n'); };

  // Abort propagation: when the browser cancels the fetch (the Stop button,
  // or a closed tab), the socket dies but the upstream Anthropic request
  // would otherwise run — and bill — to completion. res 'close' fires on
  // premature disconnect AND after a normal end, so the finished flag keeps
  // the normal path from aborting a stream that already completed.
  const upstreamAbort = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) upstreamAbort.abort(); });

  const withTools = !!body.withTools;
  const toolMode: ToolMode = body.toolMode === 'builder' ? 'builder' : 'chat';
  const messages = body.messages as Anthropic.MessageParam[];

  try {
    const client = new Anthropic({ apiKey });
    const stream = client.messages.stream({
      model: COACH_MODEL,
      // max_tokens caps thinking + response text together on current models.
      // At 1024, planning-heavy requests spent the whole budget on thinking
      // and streamed zero text (stop_reason max_tokens on 14/30 eval cases).
      max_tokens: 8192,
      thinking: { type: 'adaptive' },
      system: [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }],
      // Constant tool list (per mode) + tool_choice to gate it — see the
      // caching note above.
      tools: cachedToolSchemas(toolMode),
      ...(withTools ? {} : { tool_choice: { type: 'none' as const } }),
      messages: withTools ? withConversationBreakpoint(messages) : messages,
    }, { signal: upstreamAbort.signal });
    const usage = await streamToWireEvents(stream as AsyncIterable<UpstreamEvent>, send);
    if (usage) {
      console.log('[api/chat] usage', {
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
