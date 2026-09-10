import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';
import { applyWorkoutDraft, type WorkoutDraftAction } from '../services/workoutDraft.js';
import { sendFailure } from '../services/result.js';
import type { WorkoutDraft } from '../../../src/lib/builder/draft.js';

// POST /api/workout-draft — the builder's Apply for native clients
// (docs/ios/backend-changes.md, W7). Body:
//
//   { draft, today, action: { kind: 'create' }
//                         | { kind: 'update', eventId }
//                         | { kind: 'detach', eventId, occurrenceDate } }
//
// `draft` is the WorkoutDraft JSON the client already hands /api/coach-tool.
// Every write is user-triggered — the AI mutation cap is not charged. The
// orchestration lives in api/_lib/services/workoutDraft.ts; this is the door.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The action, or the 400 text explaining what was wrong with it. */
function parseAction(value: unknown): WorkoutDraftAction | string {
  if (!isObject(value)) return 'Unknown action';
  const kind = value.kind;
  if (kind === 'create') return { kind };
  if (kind !== 'update' && kind !== 'detach') return 'Unknown action';
  if (typeof value.eventId !== 'string' || !value.eventId) return 'Missing eventId';
  if (kind === 'update') return { kind, eventId: value.eventId };
  if (typeof value.occurrenceDate !== 'string' || !DATE_RE.test(value.occurrenceDate)) {
    return 'occurrenceDate must be a YYYY-MM-DD date';
  }
  return { kind, eventId: value.eventId, occurrenceDate: value.occurrenceDate };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const body = (req.body ?? {}) as { draft?: unknown; today?: unknown; action?: unknown };
  if (!isObject(body.draft)) {
    res.status(400).send('draft must be an object');
    return;
  }
  if (typeof body.today !== 'string' || !DATE_RE.test(body.today)) {
    res.status(400).send('today must be a YYYY-MM-DD date');
    return;
  }
  const action = parseAction(body.action);
  if (typeof action === 'string') {
    res.status(400).send(action);
    return;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const userId = await requireUser(req, res);
  if (!userId) return;
  if (!(await enforceRateLimit(supabase, res, userId, 'writes'))) return;

  const result = await applyWorkoutDraft(supabase, userId, {
    draft: body.draft as unknown as WorkoutDraft, today: body.today, action,
  });
  if (!result.ok) return sendFailure(res, result);
  res.status(200).json(result.value);
}
