import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from './supabaseAdmin.js';
import { requireUser } from './auth.js';
import {
  pickAllowed,
  BLOCK_INSERT_COLUMNS,
  BLOCK_PATCH_COLUMNS,
  OBJECTIVE_INSERT_COLUMNS,
  OBJECTIVE_PATCH_COLUMNS,
} from './allowlist.js';
import { enforceRateLimit } from './rateLimit.js';
import { parseWeeklyTargets } from '../../src/lib/blocks/targets.js';

// Writes for objectives and training blocks (phase 19), served as
// /api/blocks and /api/objectives by the consolidated router (_lib/app.ts),
// which injects query.resource to pick the branch. (Originally an events.ts
// ?resource= delegate, kept as a delegate rather than its own api/*.ts file
// because of the Vercel Hobby 12-function deploy cap.)
//
// enforceAiMutationCap is deliberately NOT called: nothing AI-driven writes
// blocks yet. When a coach tool is added, gate the non-'user' path the way
// api/events.ts does AND add block_mutations_log to the counts in
// enforceAiMutationCap — otherwise the cap silently misses these writes.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;
type Resource = 'block' | 'objective';

const TABLE: Record<Resource, string> = {
  block: 'training_blocks',
  objective: 'objectives',
};

const INSERT_COLUMNS: Record<Resource, ReadonlySet<string>> = {
  block: BLOCK_INSERT_COLUMNS,
  objective: OBJECTIVE_INSERT_COLUMNS,
};

const PATCH_COLUMNS: Record<Resource, ReadonlySet<string>> = {
  block: BLOCK_PATCH_COLUMNS,
  objective: OBJECTIVE_PATCH_COLUMNS,
};

interface MutationLogEntry {
  resource_name: string;
  diff?: Record<string, unknown>;
  /** Omitted → the DB default ('ai'); UI-driven edits send 'user'. */
  triggered_by?: 'ai' | 'user';
}

async function logMutation(
  supabase: Admin,
  userId: string,
  operation: 'create' | 'update' | 'delete',
  resource: Resource,
  resourceId: string,
  log: MutationLogEntry,
) {
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

function messageForPgError(code: string | undefined, resource: Resource): string {
  if (code === '23P01') return 'That date range overlaps an existing block';
  if (code === '23514') return `The ${resource} failed a database constraint (check the dates)`;
  if (code === '23503') return 'That objective does not exist';
  return `Failed to write the ${resource}`;
}

/** Shape-check the JSONB bags the column allowlist cannot see inside. */
function validateJsonb(resource: Resource, row: Record<string, unknown>): void {
  if (resource === 'block' && row.weekly_targets !== undefined) {
    parseWeeklyTargets(row.weekly_targets);
  }
  if (resource === 'objective' && row.required_capabilities !== undefined) {
    if (!Array.isArray(row.required_capabilities)) {
      throw new Error('required_capabilities must be an array');
    }
  }
}

/**
 * Ceiling on a single batch. Mirrors MAX_CYCLE_BLOCKS in
 * src/lib/blocks/cadence.ts — the only producer of batches today.
 */
const MAX_BATCH_ROWS = 24;

/**
 * Validate and shape one row of a batch. Returns the allowlisted columns or
 * throws with a message naming the offending index.
 */
function prepareBatchRow(raw: unknown, index: number, resource: Resource): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Row ${index + 1} is not an object`);
  }
  const row = raw as Record<string, unknown>;
  if (typeof row.name !== 'string' || !row.name.trim()) {
    throw new Error(`Row ${index + 1} needs a name`);
  }
  const { picked, rejected } = pickAllowed(row, INSERT_COLUMNS[resource]);
  if (rejected.length > 0) {
    throw new Error(`Row ${index + 1} has unknown fields: ${rejected.join(', ')}`);
  }
  validateJsonb(resource, picked);
  return picked;
}

/**
 * Insert many rows in ONE statement.
 *
 * A cycle is several blocks that only make sense together, and the non-overlap
 * exclusion constraint can reject any one of them. Looping single inserts
 * would strand the ones that already landed; a multi-row insert is a single
 * statement, so a 23P01 on row 5 rolls back rows 1–4 with it.
 */
async function handleBatchInsert(
  supabase: Admin,
  res: VercelResponse,
  userId: string,
  resource: Resource,
  body: { rows?: unknown; log?: MutationLogEntry },
): Promise<void> {
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    res.status(400).send('A batch needs a non-empty rows array');
    return;
  }
  if (body.rows.length > MAX_BATCH_ROWS) {
    res.status(400).send(`A batch cannot exceed ${MAX_BATCH_ROWS} rows`);
    return;
  }

  let prepared: Record<string, unknown>[];
  try {
    prepared = body.rows.map((row, i) => prepareBatchRow(row, i, resource));
  } catch (err) {
    res.status(400).send(err instanceof Error ? err.message : 'Invalid payload');
    return;
  }

  const { data, error } = await supabase
    .from(TABLE[resource])
    .insert(prepared.map(row => ({ ...row, user_id: userId })))
    .select('id');

  if (error) {
    const status = statusForPgError(error.code);
    if (status) {
      res.status(status).send(messageForPgError(error.code, resource));
      return;
    }
    console.error('[api/training-blocks] batch insert failed:', error.message);
    res.status(500).send(`Failed to create the ${resource}s`);
    return;
  }

  // One log row per created resource: CoachActivity reads this as the record
  // of what changed, and a single collapsed entry would under-report.
  const ids = (data ?? []).map(r => r.id as string);
  await Promise.all(ids.map((id, i) => logMutation(supabase, userId, 'create', resource, id, {
    resource_name: String(prepared[i]?.name ?? id),
    triggered_by: body.log?.triggered_by,
  })));

  res.status(200).json({ ids });
}

export async function handleTrainingBlocks(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const userId = await requireUser(req, res);
  if (!userId) return;

  const resource = req.query.resource === 'objective' ? 'objective' : 'block';
  const table = TABLE[resource];

  if (!(await enforceRateLimit(supabase, res, userId, 'writes'))) return;

  if (req.method === 'POST') {
    if (req.query.batch === '1') {
      await handleBatchInsert(supabase, res, userId, resource, (req.body ?? {}) as {
        rows?: unknown;
        log?: MutationLogEntry;
      });
      return;
    }

    const { triggered_by, log, ...row } = (req.body ?? {}) as Record<string, unknown> & {
      triggered_by?: unknown;
      log?: MutationLogEntry;
    };
    if (typeof row.name !== 'string' || !row.name.trim()) {
      res.status(400).send(`A ${resource} needs a name`);
      return;
    }
    const triggeredBy = triggered_by === 'user' || triggered_by === 'ai' ? triggered_by : undefined;

    const { picked, rejected } = pickAllowed(row, INSERT_COLUMNS[resource]);
    if (rejected.length > 0) {
      console.error('[api/training-blocks] insert rejected unknown fields:', rejected.join(', '));
      res.status(400).send(`Unknown ${resource} fields: ${rejected.join(', ')}`);
      return;
    }

    try {
      validateJsonb(resource, picked);
    } catch (err) {
      res.status(400).send(err instanceof Error ? err.message : 'Invalid payload');
      return;
    }

    const { data, error } = await supabase
      .from(table)
      .insert({ ...picked, user_id: userId })
      .select('id')
      .single();

    if (error) {
      const status = statusForPgError(error.code);
      if (status) {
        res.status(status).send(messageForPgError(error.code, resource));
        return;
      }
      console.error('[api/training-blocks] insert failed:', error.message);
      res.status(500).send(`Failed to create the ${resource}`);
      return;
    }

    await logMutation(supabase, userId, 'create', resource, data.id as string, {
      resource_name: row.name,
      triggered_by: log?.triggered_by ?? triggeredBy,
    });
    res.status(200).json({ id: data.id });
    return;
  }

  const id = typeof req.query.id === 'string' ? req.query.id : undefined;
  if (!id) {
    res.status(400).send('Missing id');
    return;
  }

  if (req.method === 'PATCH') {
    const body = req.body as { fields?: Record<string, unknown>; log?: MutationLogEntry } | undefined;
    if (!body?.fields || !body.log) {
      res.status(400).send('Missing fields or log');
      return;
    }

    const { picked, rejected } = pickAllowed(body.fields, PATCH_COLUMNS[resource]);
    if (rejected.length > 0) {
      console.error('[api/training-blocks] update rejected unknown fields:', rejected.join(', '));
      res.status(400).send(`Unknown ${resource} fields: ${rejected.join(', ')}`);
      return;
    }

    try {
      validateJsonb(resource, picked);
    } catch (err) {
      res.status(400).send(err instanceof Error ? err.message : 'Invalid payload');
      return;
    }

    // .eq('user_id') is the tenancy guard: the service-role client bypasses
    // RLS, so a forged id can only ever reach the caller's own partition.
    const { error } = await supabase
      .from(table)
      .update({ ...picked, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      const status = statusForPgError(error.code);
      if (status) {
        res.status(status).send(messageForPgError(error.code, resource));
        return;
      }
      console.error('[api/training-blocks] update failed:', error.message);
      res.status(500).send(`Failed to update the ${resource}`);
      return;
    }

    await logMutation(supabase, userId, 'update', resource, id, body.log);
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    const body = req.body as { log?: MutationLogEntry } | undefined;

    const { error } = await supabase.from(table).delete().eq('id', id).eq('user_id', userId);
    if (error) {
      console.error('[api/training-blocks] delete failed:', error.message);
      res.status(500).send(`Failed to delete the ${resource}`);
      return;
    }

    await logMutation(supabase, userId, 'delete', resource, id, body?.log ?? { resource_name: id });
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).send('Method not allowed');
}
