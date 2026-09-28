import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';
import { getAnthropicKey } from '../anthropicKey.js';
import { makeAnthropicClient } from '../anthropicClient.js';
import { fetchWeeklyInputs, generateWeeklyDocument, resolveWeek } from '../review/weekly.js';
import { defaultCoachModel, resolveCoachModel } from '../../../src/lib/coach/models.js';
import type { WeeklyReviewResponse } from '../../../src/lib/review/weekly.js';

// POST /api/weekly-review — the weekly review as a document (lane D03).
//
//   POST { today, week? }  → { document, model, warnings, generatedAt }
//   GET                    → 405: nothing is stored in v1, so there is
//                            nothing to fetch — every open regenerates.
//
// `today` is the caller's local calendar date (the server never reads its
// own clock for calendar logic); `week` (body or ?week=) is any date inside
// the ISO week to review, default the week containing today. The document is
// generated on the caller's own Anthropic key and their coach model, so the
// POST rides the `writes` bucket: it spends their money. No key answers 402
// `anthropic-key-missing`, which the client turns into "add your key in
// Profile" rather than a toast (src/lib/api.ts). A reply the server cannot
// turn into a document is a 422 carrying the parse error.
//
// Every read is scoped to the JWT's user id inside fetchWeeklyInputs.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface Body {
  today?: unknown;
  week?: unknown;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const body = (req.body ?? {}) as Body;
  if (typeof body.today !== 'string' || !DATE_RE.test(body.today)) {
    res.status(400).send('today must be a YYYY-MM-DD date');
    return;
  }
  const today = body.today;
  const week = resolveWeek(today, body.week ?? first(req.query.week as string | string[] | undefined));
  if (!week) {
    res.status(400).send('week must be a YYYY-MM-DD date');
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

  let apiKey: string | null;
  try {
    apiKey = await getAnthropicKey(supabase, userId);
  } catch (err) {
    console.error('[api/weekly-review] key lookup failed:', err instanceof Error ? err.message : err);
    res.status(500).send('Failed to load API key');
    return;
  }
  if (!apiKey) {
    res.status(402).send('anthropic-key-missing');
    return;
  }

  // Personalization and model choice are best-effort, as in coach-summary:
  // a failed profile read degrades to the generic recap on the default model.
  let athlete: { goal?: string; context?: string } = {};
  let coachModel = defaultCoachModel();
  try {
    const { data } = await supabase
      .from('profiles')
      .select('coach_goal, coach_context, coach_model')
      .eq('id', userId)
      .maybeSingle();
    athlete = { goal: data?.coach_goal ?? undefined, context: data?.coach_context ?? undefined };
    coachModel = resolveCoachModel(data?.coach_model);
  } catch (err) {
    console.error('[api/weekly-review] profile read failed:', err instanceof Error ? err.message : err);
  }

  let inputs;
  try {
    inputs = await fetchWeeklyInputs(supabase, userId, today, week, athlete);
  } catch (err) {
    console.error('[api/weekly-review] inputs failed:', err instanceof Error ? err.message : err);
    res.status(500).send('Failed to gather the week');
    return;
  }

  try {
    const result = await generateWeeklyDocument(makeAnthropicClient(apiKey), coachModel, inputs);
    if (!result.ok) {
      res.status(422).send(`The coach did not return a review document: ${result.parseError}`);
      return;
    }
    const payload: WeeklyReviewResponse = {
      document: result.document,
      model: { id: coachModel.id, label: coachModel.label, badge: coachModel.badge },
      warnings: result.warnings,
      generatedAt: new Date().toISOString(),
    };
    res.status(200).json(payload);
  } catch (err) {
    console.error('[api/weekly-review] generation failed:', err instanceof Error ? err.message : err);
    res.status(500).send('Weekly review generation failed');
  }
}
