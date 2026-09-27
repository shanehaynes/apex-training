import type Anthropic from '@anthropic-ai/sdk';
import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { ToolInputError, type McpToolDef } from '../mcp/protocol.js';
import { MCP_TOOLS } from '../mcp/toolRegistry.js';
import { getSessionSummariesTool } from '../mcp/tools/sessions.js';
import { getReviewsTool } from '../mcp/tools/reviews.js';
import { searchHistoryTool } from '../mcp/tools/history.js';

// The in-app coach's read-only tool surface: every MCP query tool plus the
// three history readers, adapted to the Anthropic tool-use loop that
// api/chat.ts runs server-side. One module, one fixed order — the prompt
// cache is a prefix match over the tool list, so the schemas must come out
// identical on every turn.
//
// Tool logic is never forked here: executeReadTool runs McpToolDef.run as
// the MCP handler would, so the coach and an external client read the same
// numbers from the same pure functions.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

const HISTORY_TOOLS: readonly McpToolDef[] = [getSessionSummariesTool, getReviewsTool, searchHistoryTool];

/**
 * The MCP query tools in registry order, then the history readers. The two
 * history tools that are also MCP-registered are filtered out of the front
 * so each name appears exactly once, at its fixed position.
 */
export const COACH_READ_TOOLS: readonly McpToolDef[] = [
  ...MCP_TOOLS.filter(t => !HISTORY_TOOLS.includes(t)),
  ...HISTORY_TOOLS,
];

const BY_NAME = new Map(COACH_READ_TOOLS.map(t => [t.name, t]));

let schemas: Anthropic.Tool[] | undefined;

/**
 * One Anthropic.Tool per read tool, same order as COACH_READ_TOOLS on every
 * call. `strict` is left unset: the MCP schemas carry neither
 * `additionalProperties: false` nor a complete `required`, and strict mode
 * would reject the optional arguments they rely on.
 */
export function readToolSchemas(): Anthropic.Tool[] {
  schemas ??= COACH_READ_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
  }));
  return schemas.map(s => ({ ...s }));
}

export function isReadToolName(name: string): boolean {
  return BY_NAME.has(name);
}

export interface ReadToolResult {
  text: string;
  isError: boolean;
}

function asArgs(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/**
 * Run one read tool for the coach loop. Never throws: a caller mistake
 * (ToolInputError) comes back as its message so the model can correct the
 * call; anything else is 'tool failed' with the message logged and nothing
 * else — never a stack, never key material.
 */
export async function executeReadTool(
  supabase: Admin,
  userId: string,
  name: string,
  input: unknown,
): Promise<ReadToolResult> {
  const tool = BY_NAME.get(name);
  if (!tool) return { text: `Unknown tool: ${name}`, isError: true };
  try {
    const payload = await tool.run(supabase, userId, asArgs(input));
    return { text: JSON.stringify(payload), isError: false };
  } catch (err) {
    if (err instanceof ToolInputError) return { text: err.message, isError: true };
    console.warn(`[coach] read tool ${name} failed:`, err instanceof Error ? err.message : String(err));
    return { text: 'tool failed', isError: true };
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const range = (a: unknown, b: unknown): string | undefined => {
  const s = str(a);
  const e = str(b);
  return s && e ? `${s} → ${e}` : s ? `from ${s}` : e ? `to ${e}` : undefined;
};
const withRange = (label: string, r: string | undefined) => (r ? `${label} ${r}` : label);

function labelFor(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'get_schedule':
      return `Checked: ${withRange('schedule', range(args.start_date, args.end_date))}`;
    case 'get_workout_detail':
      return `Checked: ${str(args.date) ? `workout on ${str(args.date)}` : 'workout detail'}`;
    case 'get_exercise_history':
      return `Checked: ${str(args.exercise_name) ? `${str(args.exercise_name)} history` : 'exercise history'}`;
    case 'get_prs': {
      const r = args.scope === 'period' ? range(args.start_date, args.end_date) : undefined;
      return `Checked: PRs (${r ?? 'all time'})`;
    }
    case 'get_period_stats': {
      const year = typeof args.year === 'number' ? String(args.year) : undefined;
      const month = args.period_type === 'month' && typeof args.month === 'number' ? ` month ${args.month}` : '';
      return `Checked: ${year ? `stats ${year}${month}` : 'stats'}`;
    }
    case 'get_training_blocks':
      return 'Checked: training blocks';
    case 'search_exercises':
      return `Checked: ${str(args.query) ? `exercise library for "${str(args.query)}"` : 'exercise library'}`;
    case 'get_meals':
      return `Checked: ${withRange('meals', range(args.start_date, args.end_date))}`;
    case 'get_session_summaries':
      return `Checked: ${withRange('session summaries', range(args.start, args.end))}`;
    case 'get_reviews':
      return `Checked: ${args.kind === 'month' ? 'monthly reviews' : args.kind === 'year' ? 'yearly reviews' : 'reviews'}`;
    case 'search_history':
      return str(args.query) ? `Searched history: "${str(args.query)}"` : 'Searched history';
    default:
      return `Checked: ${name}`;
  }
}

/** The one-line chip the UI shows for a read-tool call. Never throws. */
export function readToolLabel(name: string, input: unknown): string {
  try {
    return labelFor(name, asArgs(input));
  } catch {
    return `Checked: ${name}`;
  }
}
