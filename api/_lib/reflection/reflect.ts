import type Anthropic from '@anthropic-ai/sdk';
import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import type { CoachReflectionRow } from '../../../src/lib/db/types.js';
import { applyReflection, completeEmptyReflection, failReflection } from './apply.js';
import { fetchReflectionInputs, hasReflectableActivity, type ReflectionInputs } from './inputs.js';
import { parseReflectionOutput } from './parse.js';
import { REFLECTION_MAX_TOKENS, REFLECTION_SYSTEM_PROMPT, renderReflectionInput } from './prompt.js';

// One reflection, end to end (lane D01): the (user, day) row as the
// idempotency marker and state machine, the inputs, one model call with one
// retry on a reply that is not the JSON asked for, and the proposals written
// unconfirmed. The cron (api/_lib/handlers/reflectionCron.ts) supplies the
// client on the athlete's own key and the model they picked; this module
// never reads a key.
//
// Per (user, day):
//   done row                → already-done (nothing runs)
//   no row                  → insert `pending`; a unique violation means
//                             another run got there first → in-flight
//   pending / failed row    → resume: inputs, model, write
//   nothing on the day      → `done`, empty, resolved (no model call)
//   parse fails twice       → `failed` with the reason; tomorrow retries
//   inputs cannot be read   → `failed` likewise

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

/** The one SDK surface this module uses; a test passes a stub. */
export type ReflectionClient = Pick<Anthropic, 'messages'>;

export interface ReflectRequest {
  userId: string;
  day: string;
  /** The model id resolved for this athlete (resolveCoachModel). */
  model: string;
  client: ReflectionClient;
}

export type ReflectAction =
  | 'already-done'
  | 'in-flight'
  | 'nothing-to-reflect'
  | 'done'
  | 'failed';

export interface ReflectOutcome {
  action: ReflectAction;
  rowId: string | null;
  memoriesProposed: number;
  contractProposed: boolean;
  error?: string;
}

/** Postgres unique_violation: the (user_id, day) key already exists. */
const UNIQUE_VIOLATION = '23505';

async function findRow(supabase: Admin, userId: string, day: string): Promise<CoachReflectionRow | null> {
  const { data, error } = await supabase
    .from('coach_reflections')
    .select('*')
    .eq('user_id', userId)
    .eq('day', day)
    .maybeSingle();
  if (error) throw new Error(`coach_reflections lookup failed: ${error.message}`);
  return (data as CoachReflectionRow | null) ?? null;
}

async function claimRow(supabase: Admin, userId: string, day: string): Promise<CoachReflectionRow | 'taken'> {
  const { data, error } = await supabase
    .from('coach_reflections')
    .insert({ user_id: userId, day, status: 'pending' })
    .select('*')
    .single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return 'taken';
    throw new Error(`coach_reflections insert failed: ${error.message}`);
  }
  return data as CoachReflectionRow;
}

function textOf(response: Anthropic.Message): string {
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();
}

/**
 * Ask the model for the day's reflection: one call, and one retry that hands
 * back the parse error when the first reply was not the JSON asked for.
 * Throws with the second error when both fail.
 */
export async function askForReflection(client: ReflectionClient, model: string, inputs: ReflectionInputs) {
  const rendered = renderReflectionInput(inputs);
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: rendered }];
  const first = await client.messages.create({
    model,
    max_tokens: REFLECTION_MAX_TOKENS,
    system: REFLECTION_SYSTEM_PROMPT,
    messages,
  });
  const firstText = textOf(first);
  const parsed = parseReflectionOutput(firstText);
  if (parsed.ok) return parsed.value;

  const retry = await client.messages.create({
    model,
    max_tokens: REFLECTION_MAX_TOKENS,
    system: REFLECTION_SYSTEM_PROMPT,
    messages: [
      ...messages,
      { role: 'assistant', content: firstText || '(empty reply)' },
      { role: 'user', content: `That reply was ${parsed.error}. Reply again with ONLY the JSON object described in your instructions.` },
    ],
  });
  const second = parseReflectionOutput(textOf(retry));
  if (second.ok) return second.value;
  throw new Error(`reflection output invalid after retry: ${second.error}`);
}

/** Run one reflection for (user, day). Never throws for a per-user failure: the outcome says. */
export async function reflectForUser(supabase: Admin, req: ReflectRequest, now = new Date()): Promise<ReflectOutcome> {
  const none = { memoriesProposed: 0, contractProposed: false };

  let row = await findRow(supabase, req.userId, req.day);
  if (row?.status === 'done' || row?.status === 'resolved') {
    return { action: 'already-done', rowId: row.id, ...none };
  }
  if (!row) {
    const claimed = await claimRow(supabase, req.userId, req.day);
    if (claimed === 'taken') return { action: 'in-flight', rowId: null, ...none };
    row = claimed;
  }

  let inputs: ReflectionInputs;
  try {
    inputs = await fetchReflectionInputs(supabase, req.userId, req.day);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failReflection(supabase, row, `inputs: ${message}`);
    return { action: 'failed', rowId: row.id, ...none, error: message };
  }

  if (!hasReflectableActivity(inputs)) {
    await completeEmptyReflection(supabase, row, inputs.contract, now);
    return { action: 'nothing-to-reflect', rowId: row.id, ...none };
  }

  try {
    const output = await askForReflection(req.client, req.model, inputs);
    const applied = await applyReflection(supabase, row, output, {
      contractBefore: inputs.contract,
      existingTexts: [...inputs.memories.map(m => m.content), ...inputs.pendingMemories],
    }, now);
    return {
      action: 'done',
      rowId: applied.row.id,
      memoriesProposed: applied.memoriesProposed,
      contractProposed: applied.contractProposed,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failReflection(supabase, row, message);
    return { action: 'failed', rowId: row.id, ...none, error: message };
  }
}
