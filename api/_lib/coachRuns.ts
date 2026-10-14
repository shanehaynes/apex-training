import { createHash, randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { TablesInsert } from '../../src/lib/db/database.types.js';
import type { getSupabaseAdmin } from './supabaseAdmin.js';

// One row per coach turn (supabase/migrations/phase45_coach_runs.sql). The
// numbers api/chat.ts currently logs to stdout and loses, kept where they can
// be grouped by user, model and prompt version.
//
// FAILS OPEN, like the rate limiter next door: telemetry must never be the
// reason a coach turn fails. The row is written after the stream has already
// closed, so by the time anything here can go wrong the user has their
// answer — losing the row costs a data point; throwing would cost the request
// its clean end. Errors are logged under a stable, grep-able tag and
// swallowed.
//
// WHAT NEVER GOES IN A ROW: prompt text, message content, tool arguments, key
// material. The migration's header says why; the type below is the only place
// that could quietly widen, so widen it deliberately.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

/** The insert shape, straight from the generated schema types. */
export type CoachRunInsert = TablesInsert<'coach_runs'>;

/**
 * Record one coach turn. Resolves either way and never throws.
 */
export async function recordCoachRun(admin: Admin, row: CoachRunInsert): Promise<void> {
  try {
    const { error } = await admin.from('coach_runs').insert(row);
    if (error) console.error('[api/coach-runs] insert failed:', error.message);
  } catch (err) {
    // A rejection rather than an `error` payload — no network, a bad URL, an
    // aborted socket. Same outcome: log once, return.
    console.error('[api/coach-runs] insert failed:', err instanceof Error ? err.message : err);
  }
}

// ── One-shot server-side calls ──────────────────────────────────────────────
// chat builds its rows by hand around a streaming tool loop. The other
// surfaces that spend the athlete's tokens make plain calls, so the row is
// built here: one per model call, success or failure, mode naming the surface
// (phase57's CHECK). Every value below is a count, a timing, an identifier
// or an error message — nothing from the request or the response body.

/** The surfaces outside chat that write rows; chat's own are ChatMode. */
export type CoachRunSurface = 'summary' | 'weekly' | 'reflection' | 'recap';

/** The usage object as the SDK reports it; every field may be missing. */
export interface ModelUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** The four token columns from an SDK usage object, zeros for what is missing. */
export function usageColumns(usage: ModelUsage | null | undefined) {
  return {
    input_tokens:       usage?.input_tokens ?? 0,
    cache_read_tokens:  usage?.cache_read_input_tokens ?? 0,
    cache_write_tokens: usage?.cache_creation_input_tokens ?? 0,
    output_tokens:      usage?.output_tokens ?? 0,
  };
}

/**
 * prompt_version for a surface with no hand-bumped version: the first 12 hex
 * of sha256 over its STATIC system prompt, so it changes exactly when the
 * prompt does. Pass only fixed text — never the athlete section or anything
 * else per-user, which a hash of short text would not hide.
 */
export function promptFingerprint(...parts: string[]): string {
  return createHash('sha256').update(parts.join('')).digest('hex').slice(0, 12);
}

/** The column promises "an error message", not a payload or a stack. */
export function runErrorMessage(err: unknown): string {
  return String(err instanceof Error ? err.message : err).slice(0, 500);
}

/** What a call site knows before the call. */
export type CoachRunBase = Pick<CoachRunInsert, 'user_id' | 'model' | 'prompt_version'> & {
  mode: CoachRunSurface;
  request_id?: string;
  client?: string | null;
};

/** Run one model call and record it: usage on success, `error` on a throw (rethrown). */
export async function recordModelCall<T extends { usage?: ModelUsage | null; stop_reason?: string | null }>(
  admin: Admin,
  base: CoachRunBase,
  call: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const row = { request_id: randomUUID(), client: null, with_tools: false, ...base };
  try {
    const response = await call();
    await recordCoachRun(admin, {
      ...row,
      ...usageColumns(response.usage),
      stop_reason: response.stop_reason ?? null,
      latency_ms: Date.now() - startedAt,
    });
    return response;
  } catch (err) {
    await recordCoachRun(admin, { ...row, latency_ms: Date.now() - startedAt, error: runErrorMessage(err) });
    throw err;
  }
}

/**
 * A view of `client` whose non-streaming `messages.create` records every call
 * via recordModelCall, the model taken from each call's own params. For call
 * sites that hand the client to code this module does not own (the
 * reflection). Streaming calls are not covered: use usageColumns on the
 * stream's outcome instead.
 */
export function instrumentMessages(
  client: Pick<Anthropic, 'messages'>,
  admin: Admin,
  base: Omit<CoachRunBase, 'model'>,
): Pick<Anthropic, 'messages'> {
  const target = client.messages;
  const create = (params: Anthropic.MessageCreateParamsNonStreaming, options?: Parameters<Anthropic['messages']['create']>[1]) =>
    recordModelCall(admin, { ...base, model: params.model }, () => target.create(params, options));
  const messages = new Proxy(target, {
    get: (t, prop, receiver) => (prop === 'create' ? create : Reflect.get(t, prop, receiver)),
  });
  return { messages };
}
