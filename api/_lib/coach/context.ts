import { endOfWeek, format, parseISO, startOfWeek, subWeeks } from 'date-fns';
import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { fetchCompletionsInRange, fetchExpandedSchedule } from '../mcp/data.js';
import { fetchPeriodInputs } from '../reviewData.js';
import { loadMealsForDate } from '../trackerSession.js';
import type { ObjectiveRow, TrainingBlockRow } from '../../../src/lib/db/types.js';
import type { WorkoutEvent } from '../../../src/types/workout.js';
import type { Meal } from '../../../src/types/nutrition.js';
import { buildAnalyticsPrompt, buildBuilderPrompt, buildSystemPrompt } from '../../../src/lib/coach/prompt.js';
import type { CoachToolContext } from '../../../src/lib/coach/tools.js';
import { describeDraft, type WorkoutDraft } from '../../../src/lib/builder/draft.js';
import { describeChartDraft, type ChartDraft } from '../../../src/lib/analytics/draft.js';
import { rowToBlock, rowToObjective } from '../../../src/lib/blocks/mapping.js';
import { blockCovering, blockPeriod } from '../../../src/lib/blocks/period.js';
import { computeBlockProgress } from '../../../src/lib/blocks/progress.js';
import { buildBlockPromptSummary, type BlockPromptSummary } from '../../../src/lib/blocks/promptSummary.js';

// Server-side assembly of the coach's system prompt (docs/ios/backend-changes.md,
// W5a). The browser used to build these three prompts from its contexts and
// POST the text; now any client sends { mode, today, context } and the
// server runs the SAME pure builders (src/lib/coach/prompt.ts) over the
// caller's data, so web and native get byte-identical prompts — and the
// tool_use events can carry a confirmation label computed with real context.
//
// "Today" is the client's local calendar date: the server never reads its
// own clock for calendar logic (Vercel runs in UTC; the athlete does not).

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export type ChatMode = 'chat' | 'builder' | 'analytics';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A caller-fixable problem with the request — the handler answers 400. */
export class ChatContextError extends Error {}

export interface ChatContext {
  system: string;
  /** What displayLabel needs to name the things a tool call references. */
  toolContext: CoachToolContext;
}

export function isChatMode(value: unknown): value is ChatMode {
  return value === 'chat' || value === 'builder' || value === 'analytics';
}

function parseToday(today: unknown): { iso: string; date: Date } {
  if (typeof today !== 'string' || !DATE_RE.test(today)) {
    throw new ChatContextError('today must be a YYYY-MM-DD date');
  }
  return { iso: today, date: parseISO(today) };
}

function requireDraftObject(draft: unknown): Record<string, unknown> {
  if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) {
    throw new ChatContextError('context.draft must be an object');
  }
  return draft as Record<string, unknown>;
}

/**
 * The active block's attainment summary for the prompt — the same numbers
 * the MCP get_training_blocks tool cites. An enhancement, never a
 * precondition: any failure degrades to a prompt without it.
 */
async function blockSummary(
  supabase: Admin,
  userId: string,
  todayIso: string,
  today: Date,
  occurrences: WorkoutEvent[],
): Promise<BlockPromptSummary | null> {
  try {
    const [blocksRes, objectivesRes] = await Promise.all([
      supabase.from('training_blocks').select('*').eq('user_id', userId).order('start_date', { ascending: true }),
      supabase.from('objectives').select('*').eq('user_id', userId).order('created_at', { ascending: true }),
    ]);
    if (blocksRes.error) throw new Error(blocksRes.error.message);
    if (objectivesRes.error) throw new Error(objectivesRes.error.message);
    const blocks = ((blocksRes.data ?? []) as TrainingBlockRow[]).map(rowToBlock);
    const block = blockCovering(blocks, todayIso);
    if (!block) return null;

    const period = blockPeriod(block);
    const inputs = await fetchPeriodInputs(supabase, userId, period);
    const plannedEvents = occurrences.filter(e => e.date >= period.startDate && e.date < period.endDateExclusive);
    const progress = computeBlockProgress({ ...inputs, block, plannedEvents }, today);
    const objectives = ((objectivesRes.data ?? []) as ObjectiveRow[]).map(rowToObjective);
    return buildBlockPromptSummary(progress, objectives.find(o => o.id === block.objectiveId) ?? null);
  } catch (err) {
    console.warn('[api/chat] block summary unavailable for the prompt:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Build the system prompt and tool-label context for one chat turn.
 *
 * chat:      live schedule (this week + a 4-week completion rate), today's
 *            meals, the exercise library, athlete profile, active block.
 * builder:   the caller's workout draft, saved-workout titles, the library.
 * analytics: the caller's chart draft and the titles of "other sport" workouts.
 */
export async function buildChatContext(
  supabase: Admin,
  userId: string,
  mode: ChatMode,
  todayInput: unknown,
  draft?: unknown,
): Promise<ChatContext> {
  const { iso: todayIso, date: today } = parseToday(todayInput);

  // Every mode reads the expanded schedule: chat for the prompt itself,
  // builder/analytics for the library and titles. Anchored at today, so
  // open-ended series cover the coming year like the calendar's own view.
  const { occurrences, definitions } = await fetchExpandedSchedule(supabase, userId, todayIso);

  if (mode === 'builder') {
    const draftObj = requireDraftObject(draft);
    let draftText: string;
    try {
      draftText = describeDraft(draftObj as unknown as WorkoutDraft);
    } catch {
      throw new ChatContextError('context.draft is not a workout draft');
    }
    const { data, error } = await supabase
      .from('workout_templates')
      .select('title, archived_at')
      .eq('user_id', userId)
      .is('archived_at', null)
      .order('title', { ascending: true });
    if (error) throw new Error(`workout_templates fetch failed: ${error.message}`);
    const titles = ((data ?? []) as Array<{ title: string }>).map(t => t.title);
    return {
      system: buildBuilderPrompt(draftText, titles, definitions.values(), today),
      toolContext: { definitions, events: [], meals: [] },
    };
  }

  if (mode === 'analytics') {
    const draftObj = requireDraftObject(draft);
    let draftText: string;
    try {
      draftText = describeChartDraft(draftObj as unknown as ChartDraft);
    } catch {
      throw new ChatContextError('context.draft is not a chart draft');
    }
    // Same derivation as the tile builder's "other workouts" picker.
    const otherTitles = [...new Set(
      occurrences.filter(e => e.sport === 'other').map(e => e.title.trim()).filter(Boolean),
    )].sort();
    return {
      system: buildAnalyticsPrompt(draftText, otherTitles, today),
      toolContext: { definitions, events: [], meals: [] },
    };
  }

  // ── chat ──────────────────────────────────────────────────────────────────
  // Completion state for the window the prompt reads (this week + the four
  // before it); everything else keeps isCompleted=false like a fresh expand.
  const windowStart = format(startOfWeek(subWeeks(today, 4), { weekStartsOn: 1 }), 'yyyy-MM-dd');
  const windowEnd = format(endOfWeek(today, { weekStartsOn: 1 }), 'yyyy-MM-dd');
  const [completions, todayMeals, profileRes] = await Promise.all([
    fetchCompletionsInRange(supabase, userId, windowStart, windowEnd),
    loadMealsForDate(supabase, userId, todayIso).catch((): Meal[] => []),
    supabase.from('profiles').select('coach_goal, coach_context').eq('id', userId).maybeSingle(),
  ]);
  const completionById = new Map(completions.map(c => [c.event_id, c]));
  const events = occurrences.map(e => {
    const c = completionById.get(e.id);
    return c?.is_completed ? { ...e, isCompleted: true, completedAt: c.completed_at ?? undefined } : e;
  });
  const windowEvents = events.filter(e => e.date >= windowStart && e.date <= windowEnd);
  const todayEvents = events.filter(e => e.date === todayIso);
  const block = await blockSummary(supabase, userId, todayIso, today, events);
  const profile = profileRes.error ? null : profileRes.data;

  return {
    system: buildSystemPrompt(
      todayEvents,
      windowEvents,
      today,
      definitions.values(),
      { goal: profile?.coach_goal ?? undefined, context: profile?.coach_context ?? undefined },
      block,
      todayMeals,
    ),
    toolContext: { definitions, events, meals: todayMeals },
  };
}
