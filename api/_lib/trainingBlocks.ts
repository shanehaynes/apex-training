import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from './supabaseAdmin.js';
import { requireUser } from './auth.js';
import { pickAllowed } from './allowlist.js';
import { enforceRateLimit } from './rateLimit.js';
import {
  createBlockResource,
  deleteBlockResource,
  INSERT_COLUMNS,
  insertRows,
  logBlockMutation,
  messageForPgError,
  updateBlockResource,
  validateJsonb,
  type BlockMutationLogEntry,
  type BlockResource,
} from './services/blocks.js';
import { sendFailure } from './services/result.js';

// Writes for objectives and training blocks (phase 19), served as
// /api/blocks and /api/objectives by the consolidated router (_lib/app.ts),
// which injects query.resource to pick the branch. (Originally an events.ts
// ?resource= delegate, kept as a delegate rather than its own api/*.ts file
// because of the Vercel Hobby 12-function deploy cap.)
//
// enforceAiMutationCap is deliberately NOT called here: the web and iOS
// clients only ever send 'user'. The AI-driven block writes come through the
// MCP connector's tools (api/_lib/mcp/writeTools.ts), which reach
// services/blocks.ts directly and are gated by the cap in handlers/mcp.ts;
// block_mutations_log is among the tables enforceAiMutationCap counts.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;
type Resource = BlockResource;
type MutationLogEntry = BlockMutationLogEntry;

// The single-row writes live in services/blocks.ts (shared with the MCP
// connector's block tools); the batch insert below is the cycle commit's
// alone and keeps its own shape here.

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

/**
 * Ceiling on a single batch. Mirrors MAX_CYCLE_BLOCKS in
 * src/lib/blocks/cadence.ts — the only producer of batches today. Exported
 * so a test can pin the two equal: the cycle preview enforces the generator's
 * cap and the commit enforces this one, and they must refuse the same plan.
 */
export const MAX_BATCH_ROWS = 24;

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

  const { data, error } = await insertRows(supabase, resource, prepared.map(row => ({ ...row, user_id: userId })));

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
  const ids = (data ?? []).map(r => r.id);
  await Promise.all(ids.map((id, i) => logBlockMutation(supabase, userId, 'create', resource, id, {
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
    const triggeredBy = triggered_by === 'user' || triggered_by === 'ai' ? triggered_by : undefined;
    const result = await createBlockResource(supabase, userId, resource, row, log?.triggered_by ?? triggeredBy);
    if (!result.ok) return sendFailure(res, result);
    res.status(200).json({ id: result.value.id });
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

    const result = await updateBlockResource(supabase, userId, resource, id, body.fields, body.log);
    if (!result.ok) return sendFailure(res, result);
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    const body = req.body as { log?: MutationLogEntry } | undefined;

    const result = await deleteBlockResource(supabase, userId, resource, id, body?.log);
    if (!result.ok) return sendFailure(res, result);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).send('Method not allowed');
}
