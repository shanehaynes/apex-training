import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAdmin } from '../supabaseAdmin.js';
import { requireUser } from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';
import { fetchAllPages } from '../pagination.js';
import { fetchCompletionsInRange, fetchExpandedSchedule } from '../mcp/data.js';
import { baseIdOf } from '../../../src/lib/schedule/occurrence.js';
import { rowToTemplate } from '../../../src/lib/schedule/templates.js';
import type { WorkoutTemplateRow } from '../../../src/lib/db/types.js';
import type { ExerciseDefinition, WorkoutEvent, WorkoutTemplate } from '../../../src/types/workout.js';

// GET /api/schedule?start=YYYY-MM-DD&end=YYYY-MM-DD[&include=definitions,templates]
//
// The expanded schedule for a date window, for native clients that cannot
// run the recurrence engine (docs/ios/backend-changes.md, W0). Expansion is
// the same pure expander the calendar and the MCP get_schedule tool use, so
// every client agrees on which occurrences exist.
//
// Shape: each BASE event once (its exercises JSONB resolved against the
// library), plus one tiny stub per occurrence in the window. A weekly series
// over a four-month window is one base and ~17 stubs, not 17 copies of the
// prescription. Clients join stubs → bases by baseId.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Wider than the MCP tool's 93 days: this feeds an offline read cache. */
export const MAX_WINDOW_DAYS = 400;
const INCLUDES = new Set(['definitions', 'templates']);

export interface OccurrenceStub {
  id: string;
  baseId: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  isCompleted: boolean;
  completedAt: string | null;
}

export interface ScheduleResponse {
  window: { start: string; end: string };
  bases: WorkoutEvent[];
  occurrences: OccurrenceStub[];
  definitions?: ExerciseDefinition[];
  templates?: WorkoutTemplate[];
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

function firstQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).send('Method not allowed');
    return;
  }

  const start = firstQuery(req.query.start);
  const end = firstQuery(req.query.end);
  if (!start || !end || !DATE_RE.test(start) || !DATE_RE.test(end)) {
    res.status(400).send('start and end must be YYYY-MM-DD dates');
    return;
  }
  const span = daysBetween(start, end);
  if (Number.isNaN(span) || span < 0) {
    res.status(400).send('end must not precede start');
    return;
  }
  if (span > MAX_WINDOW_DAYS) {
    res.status(400).send(`window cannot exceed ${MAX_WINDOW_DAYS} days`);
    return;
  }
  const include = new Set(
    (firstQuery(req.query.include) ?? '').split(',').map(s => s.trim()).filter(Boolean),
  );
  for (const key of include) {
    if (!INCLUDES.has(key)) {
      res.status(400).send(`unknown include: ${key}`);
      return;
    }
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).send('Supabase admin client not configured');
    return;
  }

  const userId = await requireUser(req, res);
  if (!userId) return;
  if (!(await enforceRateLimit(supabase, res, userId, 'reads'))) return;

  const [{ occurrences, definitions }, completions, templateRows] = await Promise.all([
    // Anchor the open-ended horizon at the window's end so every requested
    // date is covered (the expander adds 366 days past the anchor).
    fetchExpandedSchedule(supabase, userId, end),
    fetchCompletionsInRange(supabase, userId, start, end),
    include.has('templates')
      ? fetchAllPages<WorkoutTemplateRow>('workout_templates', (from, to) =>
          supabase.from('workout_templates').select('*').eq('user_id', userId).order('title', { ascending: true }).range(from, to),
        )
      : Promise.resolve([] as WorkoutTemplateRow[]),
  ]);

  const completionById = new Map(completions.map(c => [c.event_id, c]));

  // The expander emits the base row itself first (at its own date), then its
  // occurrences. Whichever we see first for a baseId is the base object;
  // per-occurrence fields on it are noise the stubs supersede.
  const bases = new Map<string, WorkoutEvent>();
  const stubs: OccurrenceStub[] = [];
  for (const e of occurrences) {
    if (e.date < start || e.date > end) continue;
    const baseId = baseIdOf(e.id);
    if (!bases.has(baseId)) {
      bases.set(baseId, { ...e, id: baseId, isCompleted: false, completedAt: undefined });
    }
    const completion = completionById.get(e.id);
    stubs.push({
      id: e.id,
      baseId,
      date: e.date,
      startTime: e.startTime ?? null,
      endTime: e.endTime ?? null,
      isCompleted: completion?.is_completed ?? false,
      completedAt: completion?.is_completed ? (completion.completed_at ?? null) : null,
    });
  }

  const body: ScheduleResponse = {
    window: { start, end },
    bases: [...bases.values()],
    occurrences: stubs,
  };
  if (include.has('definitions')) body.definitions = [...definitions.values()];
  if (include.has('templates')) body.templates = templateRows.map(rowToTemplate);

  res.status(200).json(body);
}
