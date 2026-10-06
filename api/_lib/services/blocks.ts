import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import {
  pickAllowed,
  BLOCK_INSERT_COLUMNS,
  BLOCK_PATCH_COLUMNS,
  OBJECTIVE_INSERT_COLUMNS,
  OBJECTIVE_PATCH_COLUMNS,
} from '../allowlist.js';
import { parseWeeklyTargets } from '../../../src/lib/blocks/targets.js';
import { fail, succeed, type ServiceResult } from './result.js';
import type { Json, TablesInsert, TablesUpdate } from '../../../src/lib/db/types.js';
import type { TriggeredBy } from './events.js';

// Objective and training-block writes (phase 19), extracted from
// api/_lib/trainingBlocks.ts so the HTTP handler and the MCP connector's
// block tools (api/_lib/mcp/writeTools.ts) share one implementation. Every
// function takes the verified user id and scopes its writes by it; auth,
// rate limits and the AI cap stay with the callers. Every mutation appends
// to block_mutations_log, which enforceAiMutationCap counts.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;
export type BlockResource = 'block' | 'objective';

// Both tables carry the id / user_id / updated_at columns these writes
// touch, but postgrest-js types a union table name as the intersection of
// the two schemas, so each write dispatches on the resource and names one
// table per branch. The payloads are allowlist-filtered request bodies
// (INSERT_COLUMNS / PATCH_COLUMNS) validated at runtime; the cast names the
// table they are bound for so the column names are checked against it.
type Patch = Record<string, unknown>;

export function insertRows(supabase: Admin, resource: BlockResource, rows: Patch[]) {
  return resource === 'block'
    ? supabase.from('training_blocks').insert(rows as TablesInsert<'training_blocks'>[]).select('id')
    : supabase.from('objectives').insert(rows as TablesInsert<'objectives'>[]).select('id');
}

function insertRow(supabase: Admin, resource: BlockResource, row: Patch) {
  return resource === 'block'
    ? supabase.from('training_blocks').insert(row as TablesInsert<'training_blocks'>).select('id').single()
    : supabase.from('objectives').insert(row as TablesInsert<'objectives'>).select('id').single();
}

// .eq('user_id') is the tenancy guard: the service-role client bypasses
// RLS, so a forged id can only ever reach the caller's own partition.
function updateRow(supabase: Admin, resource: BlockResource, id: string, userId: string, patch: Patch) {
  return resource === 'block'
    ? supabase.from('training_blocks').update(patch as TablesUpdate<'training_blocks'>).eq('id', id).eq('user_id', userId)
    : supabase.from('objectives').update(patch as TablesUpdate<'objectives'>).eq('id', id).eq('user_id', userId);
}

function deleteRow(supabase: Admin, resource: BlockResource, id: string, userId: string) {
  return resource === 'block'
    ? supabase.from('training_blocks').delete().eq('id', id).eq('user_id', userId)
    : supabase.from('objectives').delete().eq('id', id).eq('user_id', userId);
}

export const INSERT_COLUMNS: Record<BlockResource, ReadonlySet<string>> = {
  block: BLOCK_INSERT_COLUMNS,
  objective: OBJECTIVE_INSERT_COLUMNS,
};

const PATCH_COLUMNS: Record<BlockResource, ReadonlySet<string>> = {
  block: BLOCK_PATCH_COLUMNS,
  objective: OBJECTIVE_PATCH_COLUMNS,
};

export interface BlockMutationLogEntry {
  resource_name: string;
  diff?: Json;
  /** Omitted → the DB default ('ai'); UI-driven edits send 'user'. */
  triggered_by?: TriggeredBy;
}

export async function logBlockMutation(
  supabase: Admin,
  userId: string,
  operation: 'create' | 'update' | 'delete',
  resource: BlockResource,
  resourceId: string,
  log: BlockMutationLogEntry,
): Promise<void> {
  const { error } = await supabase.from('block_mutations_log').insert({
    user_id: userId,
    operation,
    resource,
    resource_id: resourceId,
    resource_name: log.resource_name,
    diff: log.diff,
    // Runtime guard, not just the type: the entry arrives in request bodies.
    ...(log.triggered_by === 'ai' || log.triggered_by === 'user'
      ? { triggered_by: log.triggered_by }
      : {}),
  });
  if (error) console.error('[api/training-blocks] mutation log insert failed:', error.message);
}

/**
 * Postgres error codes worth translating. 23P01 is the non-overlap exclusion
 * constraint — a user-correctable conflict, not a server fault, so it must
 * not surface as a 500. 23514 is a CHECK (non-Monday dates, bad range).
 */
function statusForPgError(code: string | undefined): number | null {
  if (code === '23P01') return 409;
  if (code === '23514') return 400;
  if (code === '23503') return 400;   // objective_id pointing at nothing
  return null;
}

export function messageForPgError(code: string | undefined, resource: BlockResource): string {
  if (code === '23P01') return 'That date range overlaps an existing block';
  if (code === '23514') return `The ${resource} failed a database constraint (check the dates)`;
  if (code === '23503') return 'That objective does not exist';
  return `Failed to write the ${resource}`;
}

/** The ServiceResult for a failed write: a translated constraint error, or a logged 500. */
function failedWrite<T = never>(
  error: { code?: string; message: string },
  resource: BlockResource,
  context: string,
  fallback: string,
): ServiceResult<T> {
  const status = statusForPgError(error.code);
  if (status) return fail(status, messageForPgError(error.code, resource));
  console.error(`[api/training-blocks] ${context} failed:`, error.message);
  return fail(500, fallback);
}

/** Shape-check the JSONB bags the column allowlist cannot see inside. */
export function validateJsonb(resource: BlockResource, row: Record<string, unknown>): void {
  if (resource === 'block' && row.weekly_targets !== undefined) {
    parseWeeklyTargets(row.weekly_targets);
  }
  if (resource === 'objective' && row.required_capabilities !== undefined) {
    if (!Array.isArray(row.required_capabilities)) {
      throw new Error('required_capabilities must be an array');
    }
  }
}

/** Insert one block or objective (snake_case, allowlisted) and log it. */
export async function createBlockResource(
  supabase: Admin,
  userId: string,
  resource: BlockResource,
  row: Record<string, unknown>,
  triggeredBy: TriggeredBy | undefined,
): Promise<ServiceResult<{ id: string }>> {
  if (typeof row.name !== 'string' || !row.name.trim()) {
    return fail(400, `A ${resource} needs a name`);
  }

  const { picked, rejected } = pickAllowed(row, INSERT_COLUMNS[resource]);
  if (rejected.length > 0) {
    console.error('[api/training-blocks] insert rejected unknown fields:', rejected.join(', '));
    return fail(400, `Unknown ${resource} fields: ${rejected.join(', ')}`);
  }

  try {
    validateJsonb(resource, picked);
  } catch (err) {
    return fail(400, err instanceof Error ? err.message : 'Invalid payload');
  }

  const { data, error } = await insertRow(supabase, resource, { ...picked, user_id: userId });
  if (error) return failedWrite(error, resource, 'insert', `Failed to create the ${resource}`);

  await logBlockMutation(supabase, userId, 'create', resource, data.id, {
    resource_name: row.name,
    triggered_by: triggeredBy,
  });
  return succeed({ id: data.id as string });
}

/** Patch one block or objective the caller owns (allowlisted fields) and log it. */
export async function updateBlockResource(
  supabase: Admin,
  userId: string,
  resource: BlockResource,
  id: string,
  fields: Record<string, unknown>,
  log: BlockMutationLogEntry,
): Promise<ServiceResult> {
  const { picked, rejected } = pickAllowed(fields, PATCH_COLUMNS[resource]);
  if (rejected.length > 0) {
    console.error('[api/training-blocks] update rejected unknown fields:', rejected.join(', '));
    return fail(400, `Unknown ${resource} fields: ${rejected.join(', ')}`);
  }

  try {
    validateJsonb(resource, picked);
  } catch (err) {
    return fail(400, err instanceof Error ? err.message : 'Invalid payload');
  }

  const { error } = await updateRow(supabase, resource, id, userId, {
    ...picked,
    updated_at: new Date().toISOString(),
  });
  if (error) return failedWrite(error, resource, 'update', `Failed to update the ${resource}`);

  await logBlockMutation(supabase, userId, 'update', resource, id, log);
  return succeed(undefined);
}

/** Delete one block or objective the caller owns and log it. */
export async function deleteBlockResource(
  supabase: Admin,
  userId: string,
  resource: BlockResource,
  id: string,
  log: BlockMutationLogEntry | undefined,
): Promise<ServiceResult> {
  const { error } = await deleteRow(supabase, resource, id, userId);
  if (error) {
    console.error('[api/training-blocks] delete failed:', error.message);
    return fail(500, `Failed to delete the ${resource}`);
  }

  await logBlockMutation(supabase, userId, 'delete', resource, id, log ?? { resource_name: id });
  return succeed(undefined);
}
