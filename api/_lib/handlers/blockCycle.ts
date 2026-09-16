import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';
import type { TrainingBlockRow } from '../../../src/lib/db/types.js';
import {
  cycleTotalWeeks,
  generateCycle,
  isCycleSpecError,
  overlapsExisting,
  type CycleSpec,
} from '../../../src/lib/blocks/cadence.js';
import { isValidationError } from '../../../src/lib/blocks/validate.js';
import { blockToRow, rowToBlock } from '../../../src/lib/blocks/mapping.js';

// The cycle generator's preview (docs/ios/backend-changes.md, W10), served
// as `POST /api/blocks?resource=cycle { spec }` by the consolidated router.
// It runs the web's own src/lib/blocks/cadence.ts over the spec — nothing
// about cadence, Monday snapping or recovery scaling exists in Swift
// (D-008), and since W10 the web's own preview goes through here too.
//
// Preview only: nothing is written. The response carries the blocks two
// ways — `blocks` (camelCase, what a preview renders) and `rows` (the
// snake_case insert rows, the exact `?batch=1` body) — so a client commits
// what it was shown without spelling a column. `conflict` names the first
// existing block the cycle would overlap, the courtesy check the web's
// editor used to run client-side; the DB exclusion constraint stays the
// real guard on commit.
//
// A spec that cannot generate answers 200 { ok:false, problem } with the
// generator's own person-phrased text (the /api/workout-draft convention).
// 4xx stays for a body that is not a spec at all.
//
// Rate bucket: `reads`, not `writes`. The preview fires on a debounce
// while the user types, writes nothing, and would exhaust the 120/hour
// writes budget in one editing session.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER_KEYS = ['weeksOn', 'weeksOff', 'cycles', 'recoveryScale'] as const;

function specShapeProblem(spec: unknown): string | null {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) return 'spec must be an object';
  const s = spec as Record<string, unknown>;
  if (typeof s.startDate !== 'string' || !DATE_RE.test(s.startDate)) return 'spec.startDate must be a YYYY-MM-DD date';
  for (const key of NUMBER_KEYS) {
    if (typeof s[key] !== 'number' || !Number.isFinite(s[key])) return `spec.${key} must be a number`;
  }
  if (typeof s.namePrefix !== 'string') return 'spec.namePrefix must be a string';
  if (s.intent !== undefined && s.intent !== null && typeof s.intent !== 'string') return 'spec.intent must be a string';
  if (s.objectiveId !== undefined && s.objectiveId !== null && typeof s.objectiveId !== 'string') {
    return 'spec.objectiveId must be a string';
  }
  if (s.weeklyTargets !== undefined && s.weeklyTargets !== null) {
    if (typeof s.weeklyTargets !== 'object' || Array.isArray(s.weeklyTargets)) return 'spec.weeklyTargets must be an object';
  }
  return null;
}

/** The checked body as the generator's input; blank optionals are dropped. */
function toSpec(s: Record<string, unknown>): CycleSpec {
  return {
    startDate: s.startDate as string,
    weeksOn: s.weeksOn as number,
    weeksOff: s.weeksOff as number,
    cycles: s.cycles as number,
    namePrefix: s.namePrefix as string,
    intent: typeof s.intent === 'string' ? s.intent : undefined,
    objectiveId: typeof s.objectiveId === 'string' && s.objectiveId ? s.objectiveId : undefined,
    weeklyTargets: (s.weeklyTargets ?? {}) as CycleSpec['weeklyTargets'],
    recoveryScale: s.recoveryScale as number,
  };
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

  const body = (req.body ?? {}) as { spec?: unknown };
  const shape = specShapeProblem(body.spec);
  if (shape) {
    res.status(400).send(shape);
    return;
  }

  const userId = await requireUser(req, res);
  if (!userId) return;
  if (!(await enforceRateLimit(supabase, res, userId, 'reads'))) return;

  const spec = toSpec(body.spec as Record<string, unknown>);
  let blocks: ReturnType<typeof generateCycle>;
  try {
    blocks = generateCycle(spec);
  } catch (err) {
    // The generator and the per-block validator both speak to a person; a
    // spec they refuse is a problem the editor shows, not a malformed request.
    if (isCycleSpecError(err) || isValidationError(err)) {
      res.status(200).json({ ok: false, problem: err.message });
      return;
    }
    res.status(400).send('spec is not a cycle spec');
    return;
  }

  const { data, error } = await supabase
    .from('training_blocks')
    .select('*')
    .eq('user_id', userId)
    .order('start_date', { ascending: true });
  if (error) {
    console.error('[api/blocks cycle] training_blocks fetch failed:', error.message);
    res.status(500).send('Failed to load blocks');
    return;
  }
  const existing = ((data ?? []) as TrainingBlockRow[]).map(rowToBlock);
  const hit = overlapsExisting(blocks, existing);

  res.status(200).json({
    ok: true,
    blocks,
    rows: blocks.map(blockToRow),
    totalWeeks: cycleTotalWeeks(spec),
    conflict: hit
      ? { id: hit.id, name: hit.name, startDate: hit.startDate, endDateExclusive: hit.endDateExclusive }
      : null,
  });
}
