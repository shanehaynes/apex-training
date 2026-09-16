import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';
import { loadAnalyticsInputs } from '../analyticsData.js';
import { computeTile, type ComputeContext, type TileResult } from '../../../src/lib/analytics/engine.js';
import { needsHrZones, specProblem, upgradeSpec, type ChartSpec } from '../../../src/lib/analytics/spec.js';
import { specFromDraft, type ChartDraft } from '../../../src/lib/analytics/draft.js';
import { unionWindow } from '../../../src/lib/analytics/window.js';
import { blockCovering, blockPeriod } from '../../../src/lib/blocks/period.js';
import { rowToBlock } from '../../../src/lib/blocks/mapping.js';
import type { TrainingBlockRow } from '../../../src/lib/db/types.js';

// POST /api/analytics-compute { specs: ChartSpec[], today } → { today, tiles: TileResult[] }
//                          or { drafts: ChartDraft[], today }
//
// The analytics engine (src/lib/analytics/engine.ts) run server-side over the
// caller's rows (docs/ios/backend-changes.md, W8): a native client renders
// TileData and never fetches raw logs or ports the aggregation. Results are
// index-aligned with the request; an invalid spec answers with its problem
// text in that slot, exactly as the dashboard's error tile does.
//
// `drafts` (W9) is the native tile builder's live preview: the builder's
// ChartDraft runs through the web's own specFromDraft here, and a draft the
// web would refuse answers its person-phrased problem in that slot — the
// same text the web shows under the preview. Exactly one of the two arrays.
//
// "Today" is the caller's local calendar date — the engine never reads the
// clock — and the current-block preset resolves against the active block.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A whole dashboard; the builder sends one. */
export const MAX_SPECS = 24;

/** One decimal is plenty for a Server-Timing duration. */
const durMs = (ms: number): number => Math.round(ms * 10) / 10;

type Slot = ChartSpec | { problem: string };

function slotFromSpec(json: unknown): Slot {
  const spec = upgradeSpec(json);
  if (!spec) return { problem: 'spec must be a version-1 chart spec' };
  const problem = specProblem(spec);
  return problem ? { problem } : spec;
}

function slotFromDraft(json: unknown): Slot {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { problem: 'draft must be an object' };
  try {
    const built = specFromDraft(json as ChartDraft);
    return 'error' in built ? { problem: built.error } : built.spec;
  } catch {
    return { problem: 'draft is not a chart draft' };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const body = (req.body ?? {}) as { specs?: unknown; drafts?: unknown; today?: unknown };
  const isBatch = (v: unknown): v is unknown[] => Array.isArray(v) && v.length >= 1 && v.length <= MAX_SPECS;
  const hasSpecs = body.specs !== undefined;
  const hasDrafts = body.drafts !== undefined;
  if (hasSpecs === hasDrafts || !isBatch(hasSpecs ? body.specs : body.drafts)) {
    res.status(400).send(`specs or drafts must be an array of 1-${MAX_SPECS}`);
    return;
  }
  if (typeof body.today !== 'string' || !DATE_RE.test(body.today)) {
    res.status(400).send('today must be a YYYY-MM-DD date');
    return;
  }
  const todayIso = body.today;

  // Shape-check every entry up front so a malformed one becomes a problem
  // slot, not a crash mid-batch; the engine re-validates deeply.
  const specs: Slot[] = hasSpecs
    ? (body.specs as unknown[]).map(slotFromSpec)
    : (body.drafts as unknown[]).map(slotFromDraft);
  const valid = specs.filter((s): s is ChartSpec => !('problem' in s));

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const userId = await requireUser(req, res);
  if (!userId) return;
  if (!(await enforceRateLimit(supabase, res, userId, 'reads'))) return;

  const startedAt = performance.now();
  try {
    const [profileRes, blocksRes] = await Promise.all([
      supabase.from('profiles').select('max_hr, threshold_hr').eq('id', userId).maybeSingle(),
      supabase.from('training_blocks').select('*').eq('user_id', userId).order('start_date', { ascending: true }),
    ]);
    if (profileRes.error) throw new Error(`profiles fetch failed: ${profileRes.error.message}`);
    if (blocksRes.error) throw new Error(`training_blocks fetch failed: ${blocksRes.error.message}`);

    const hr = { maxHr: profileRes.data?.max_hr ?? null, thresholdHr: profileRes.data?.threshold_hr ?? null };
    const active = blockCovering(((blocksRes.data ?? []) as TrainingBlockRow[]).map(rowToBlock), todayIso);
    const ctx: ComputeContext = { todayIso, activeBlock: active ? blockPeriod(active) : null, hr };

    const window = unionWindow(valid, todayIso, ctx.activeBlock);
    const inputs = window
      ? await loadAnalyticsInputs(supabase, userId, window, { withHrZones: needsHrZones(valid), hr })
      : null;

    const loadedAt = performance.now();

    const tiles: TileResult[] = specs.map(spec =>
      'problem' in spec
        ? { ok: false, problem: spec.problem }
        : inputs
          ? computeTile(spec, inputs, ctx)
          : computeTile(spec, { completions: [], sessions: [], setLogs: [], cardioLogs: [], meals: [], zoneActivities: [], categories: new Map(), events: new Map() }, ctx),
    );

    // Splits the request's two halves — reading the caller's rows versus
    // aggregating them — so a latency check on a deployed preview can tell
    // server work from network time. The web's dashboard runs on this call
    // since #152, which is what made the split worth having.
    res.setHeader(
      'Server-Timing',
      `data;dur=${durMs(loadedAt - startedAt)}, compute;dur=${durMs(performance.now() - loadedAt)}`,
    );
    res.status(200).json({ today: todayIso, tiles });
  } catch (err) {
    console.error('[api/analytics-compute] failed:', err instanceof Error ? err.message : err);
    res.status(500).send('Failed to compute tiles');
  }
}
