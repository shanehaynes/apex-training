import type { McpToolDef } from '../protocol.js';
import { ToolInputError } from '../protocol.js';
import { optionalBoolean, requireDateRange } from '../args.js';
import { fetchAllPages } from '../../pagination.js';
import { viewPath } from '../../coach/memory.js';
import { MEMORY_ROOT, memoryPathList } from '../../../../src/lib/coach/memory.js';
import { rowToTemplate } from '../../../../src/lib/schedule/templates.js';
import type { WorkoutTemplateRow } from '../../../../src/lib/db/types.js';
import type { Exercise } from '../../../../src/types/workout.js';

// Read tools that exist for the connector only (api/_lib/mcp/
// connectorRegistry.ts): the profile, the workout library, coach notes and
// coach memory. They are NOT in MCP_TOOLS — that list is also the in-app
// coach's read surface (api/_lib/coach/readTools.ts), which already has the
// profile and memory in its prompt and would only pay for duplicate tools.

const MAX_NOTES_RANGE_DAYS = 366;

export const getProfileTool: McpToolDef = {
  name: 'get_profile',
  description:
    "The user's profile as the coach sees it: display name, goal line, context paragraph, coaching contract " +
    '(their own text on how they want to be coached), heart-rate settings, and whether the nightly reflection ' +
    'is on. Read the contract here before propose_contract_edit.',
  inputSchema: { type: 'object', properties: {} },
  async run(supabase, userId) {
    const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (error) throw new Error(`profile read failed: ${error.message}`);
    const row = (data ?? {}) as Record<string, unknown>;
    const text = (key: string) => (typeof row[key] === 'string' ? (row[key] as string) : null);
    const int = (key: string) => (typeof row[key] === 'number' ? (row[key] as number) : null);
    return {
      display_name: text('display_name'),
      coach_goal: text('coach_goal'),
      coach_context: text('coach_context'),
      coaching_contract: text('coach_contract'),
      reflection_opt_in: row.reflection_opt_in === true,
      max_hr: int('max_hr'),
      threshold_hr: int('threshold_hr'),
    };
  },
};

export const getCoachMemoryTool: McpToolDef = {
  name: 'get_coach_memory',
  description:
    "The coach's long-term memory about the user — injuries, preferences, goals, history, notes — as the " +
    `in-app coach reads it. Without a path, the directory listing; with one of ${memoryPathList()}, that file. ` +
    'Each fact carries an [id:…] marker that update_coach_memory can name.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: `${MEMORY_ROOT} (default) or one of its files.` } },
  },
  async run(supabase, userId, args) {
    const path = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : MEMORY_ROOT;
    const view = await viewPath(supabase, userId, path);
    if (view.isError) throw new ToolInputError(view.text);
    return { path, text: view.text };
  },
};

function exerciseNames(list: Exercise[] | undefined): string[] {
  return (list ?? []).map(e => e.name);
}

export const getWorkoutTemplatesTool: McpToolDef = {
  name: 'get_workout_templates',
  description:
    "The user's workout library: the reusable workouts the calendar's builder saves. Each carries its type, " +
    'scoring (none, for-time, amrap), planned duration and exercise names. Archived templates are hidden ' +
    'unless asked for.',
  inputSchema: {
    type: 'object',
    properties: { include_archived: { type: 'boolean', description: 'Also list archived templates (default false).' } },
  },
  async run(supabase, userId, args) {
    const includeArchived = optionalBoolean(args, 'include_archived', false);
    const rows = await fetchAllPages<WorkoutTemplateRow>('workout_templates', (from, to) =>
      supabase.from('workout_templates').select('*').eq('user_id', userId).order('title', { ascending: true }).range(from, to),
    );
    const templates = rows
      .filter(row => includeArchived || !row.archived_at)
      .map(row => {
        const t = rowToTemplate(row);
        return {
          id: t.id,
          title: t.title,
          type: t.type,
          sport: t.sport ?? null,
          scoring_type: t.scoringType,
          time_cap_minutes: t.timeCapMinutes ?? null,
          estimated_duration: t.estimatedDuration,
          difficulty: t.difficulty,
          description: t.description,
          location: t.location ?? null,
          warmup: exerciseNames(t.warmup),
          exercises: exerciseNames(t.exercises),
          cooldown: exerciseNames(t.cooldown),
          archived: !!row.archived_at,
        };
      });
    return { templates };
  },
};

export const getNotesTool: McpToolDef = {
  name: 'get_notes',
  description:
    'Live coach notes: the chips pinned to calendar days, workouts and training blocks (by the in-app coach, ' +
    'the nightly reflection, or leave_note). Day notes inside the date range (max 366 days), plus every live ' +
    'workout and block note. Each carries the id dismiss_note takes.',
  inputSchema: {
    type: 'object',
    properties: {
      start_date: { type: 'string', description: 'Range start for day notes, YYYY-MM-DD (inclusive).' },
      end_date: { type: 'string', description: 'Range end, YYYY-MM-DD (inclusive).' },
    },
    required: ['start_date', 'end_date'],
  },
  async run(supabase, userId, args) {
    const { startDate, endDate } = requireDateRange(args, MAX_NOTES_RANGE_DAYS);
    const columns = 'id, target_kind, target_id, body, severity, created_by, created_at';
    const [days, rest] = await Promise.all([
      supabase
        .from('coach_annotations')
        .select(columns)
        .eq('user_id', userId)
        .eq('target_kind', 'day')
        .is('dismissed_at', null)
        .gte('target_id', startDate)
        .lte('target_id', endDate),
      supabase
        .from('coach_annotations')
        .select(columns)
        .eq('user_id', userId)
        .in('target_kind', ['event', 'block'])
        .is('dismissed_at', null),
    ]);
    const failed = days.error ?? rest.error;
    if (failed) throw new Error(`notes read failed: ${failed.message}`);
    return { notes: [...(days.data ?? []), ...(rest.data ?? [])] };
  },
};

export const ACCOUNT_READ_TOOLS: readonly McpToolDef[] = [
  getProfileTool,
  getWorkoutTemplatesTool,
  getNotesTool,
  getCoachMemoryTool,
];
