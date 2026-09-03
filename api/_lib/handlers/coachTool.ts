import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceAiMutationCap, enforceRateLimit } from '../rateLimit.js';
import { fetchExpandedSchedule } from '../mcp/data.js';
import { loadMealsForDate } from '../trackerSession.js';
import { createServerDeps } from '../coach/serverDeps.js';
import { findCoachTool } from '../../../src/lib/coach/tools.js';
import { applyDraftUpdate, type DraftUpdateInput, type WorkoutDraft } from '../../../src/lib/builder/draft.js';
import { applyChartDraftUpdate, type ChartDraft, type DraftUpdateInput as ChartDraftUpdateInput } from '../../../src/lib/analytics/draft.js';
import { rowToMeal } from '../../../src/lib/nutrition/mapping.js';
import type { MealRow } from '../../../src/lib/db/types.js';

// POST /api/coach-tool — execute one CONFIRMED coach tool call on the server
// (docs/ios/backend-changes.md, W5b). The chat stream hands the client a
// tool_use; the user confirms; the client posts it here and gets the
// tool_result text back for the next turn. The executors are the ones in
// src/lib/coach/tools.ts — what the evals test — over the service-role
// client, so no client carries them and attribution ('ai') is stamped here
// rather than declared by the caller.
//
//   { toolUseId?, name, input, today }            mutation tools → { ok, resultText }
//   { name, input, today, draft }  update_workout_draft / update_chart_draft
//                                                 → { ok, resultText, draft }
// Draft tools are a stateless reduce: the caller's draft in, the next draft
// out, with the reducer's own validation text as the tool_result.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DRAFT_TOOLS = new Set(['update_workout_draft', 'update_chart_draft']);

interface Body {
  toolUseId?: unknown;
  name?: unknown;
  input?: unknown;
  today?: unknown;
  draft?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const body = (req.body ?? {}) as Body;
  const name = typeof body.name === 'string' ? body.name : '';
  const tool = DRAFT_TOOLS.has(name) ? null : findCoachTool(name);
  if (!name || (!tool && !DRAFT_TOOLS.has(name))) {
    res.status(400).send('Unknown tool');
    return;
  }
  if (body.input !== undefined && !isObject(body.input)) {
    res.status(400).send('input must be an object');
    return;
  }
  if (typeof body.today !== 'string' || !DATE_RE.test(body.today)) {
    res.status(400).send('today must be a YYYY-MM-DD date');
    return;
  }
  const input = (body.input ?? {}) as Record<string, unknown>;
  const today = body.today;

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const userId = await requireUser(req, res);
  if (!userId) return;

  // ── draft tools: reduce the caller's draft, persist nothing ──────────────
  if (!tool) {
    if (!(await enforceRateLimit(supabase, res, userId, 'reads'))) return;
    if (!isObject(body.draft)) {
      res.status(400).send('draft must be an object');
      return;
    }
    try {
      if (name === 'update_workout_draft') {
        const { definitions } = await fetchExpandedSchedule(supabase, userId, today);
        const result = applyDraftUpdate(body.draft as unknown as WorkoutDraft, input as unknown as DraftUpdateInput, definitions);
        res.status(200).json('error' in result
          ? { ok: false, resultText: result.error, draft: body.draft }
          : { ok: true, resultText: result.summary, draft: result.draft });
      } else {
        const result = applyChartDraftUpdate(body.draft as unknown as ChartDraft, input as unknown as ChartDraftUpdateInput);
        res.status(200).json('error' in result
          ? { ok: false, resultText: result.error, draft: body.draft }
          : { ok: true, resultText: result.summary, draft: result.draft });
      }
    } catch (err) {
      console.error(`[api/coach-tool] ${name} reduce failed:`, err instanceof Error ? err.message : err);
      res.status(400).send('draft is not a valid draft');
    }
    return;
  }

  // ── mutation tools ────────────────────────────────────────────────────────
  if (!(await enforceRateLimit(supabase, res, userId, 'writes'))) return;
  // The cap counts AI-attributed log rows; the executors below stamp 'ai'
  // themselves, so this is the one place the coach's volume is guarded.
  if (!(await enforceAiMutationCap(supabase, res, userId))) return;

  try {
    const [{ occurrences, definitions }, todayMeals] = await Promise.all([
      fetchExpandedSchedule(supabase, userId, today),
      loadMealsForDate(supabase, userId, today).catch(() => []),
    ]);
    // update_meal validates the fat split against the current row, which
    // need not be today's — fetch the one the call names.
    const meals = [...todayMeals];
    if (typeof input.meal_id === 'string' && !meals.some(m => m.id === input.meal_id)) {
      const { data } = await supabase.from('meals').select('*').eq('user_id', userId).eq('id', input.meal_id).maybeSingle();
      if (data) meals.push(rowToMeal(data as MealRow));
    }
    const deps = createServerDeps(supabase, userId, { today, events: occurrences, definitions, meals });
    const resultText = await tool.execute(input, deps);
    res.status(200).json({ ok: true, resultText });
  } catch (err) {
    console.error(`[api/coach-tool] ${name} failed:`, err instanceof Error ? err.message : err);
    res.status(500).send('Tool execution failed');
  }
}
