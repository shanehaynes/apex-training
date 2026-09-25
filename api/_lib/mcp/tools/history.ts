import type { McpToolDef } from '../protocol.js';
import { ToolInputError } from '../protocol.js';
import { optionalInt, requireDate, requireString } from '../args.js';

// Free-text search over everything the coach and the athlete have written:
// past chat turns, post-workout summaries, review commentary, objective
// notes. Postgres full-text search through PostgREST's textSearch (websearch
// syntax, so quotes and -exclusions work), no index — a personal training
// log is hobby scale and a sequential scan over it is milliseconds.
//
// NOT an MCP tool. It reads coach_messages, which is service-role only and
// never leaves the app: the MCP handler is an external, untrusted-input
// channel with its own bearer tokens, and a connected client must not be
// able to replay the athlete's private conversations. The in-app coach
// reaches it through api/_lib/coach/readTools.ts only.

type Admin = Parameters<McpToolDef['run']>[0];

export const HISTORY_KINDS = ['message', 'session_summary', 'review', 'objective'] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

const MAX_QUERY_CHARS = 200;
const MAX_LIMIT = 30;
const SNIPPET_CHARS = 240;
const DAY_MS = 86_400_000;

export interface HistoryHit {
  kind: HistoryKind;
  sourceId: string;
  /** YYYY-MM-DD: the session date, else when the text was written/updated. */
  date: string;
  snippet: string;
}

interface Window {
  /** Inclusive lower bound, YYYY-MM-DD. */
  start?: string;
  /** Exclusive upper bound, YYYY-MM-DD (the day after `end`). */
  endExclusive?: string;
}

function optionalDate(args: Record<string, unknown>, key: string): string | undefined {
  return args[key] === undefined || args[key] === null ? undefined : requireDate(args, key);
}

function shiftDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

function parseKinds(args: Record<string, unknown>): HistoryKind[] {
  const value = args.kinds;
  if (value === undefined || value === null) return [...HISTORY_KINDS];
  if (!Array.isArray(value) || value.length === 0 || !value.every(k => (HISTORY_KINDS as readonly unknown[]).includes(k))) {
    throw new ToolInputError(`kinds must be a non-empty array of: ${HISTORY_KINDS.join(', ')}.`);
  }
  return [...new Set(value as HistoryKind[])];
}

/** The words a websearch query looks for, minus operators and exclusions. */
export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/["]/g, ' ')
    .split(/\s+/)
    .filter(t => t && t !== 'or' && !t.startsWith('-'))
    .map(t => t.replace(/[^\p{L}\p{N}]+$/u, '').replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter(Boolean);
}

/**
 * At most `max` characters of `text`, centred on the first query term it
 * contains. Postgres stems ("shoulders" matches "shoulder"), so a term that
 * is not present verbatim is retried as its first four letters before the
 * snippet gives up and shows the opening of the text.
 */
export function snippetAround(text: string, query: string, max = SNIPPET_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  let at = -1;
  for (const term of queryTerms(query)) {
    let i = lower.indexOf(term);
    if (i === -1 && term.length > 4) i = lower.indexOf(term.slice(0, 4));
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  let start = at === -1 ? 0 : Math.max(0, at - Math.floor(max / 2));
  let end = start + max;
  if (end > flat.length) {
    end = flat.length;
    start = Math.max(0, end - max);
  }
  let out = flat.slice(start, end);
  if (start > 0) out = `…${out.slice(1)}`;
  if (end < flat.length) out = `${out.slice(0, -1)}…`;
  return out;
}

const dayOf = (timestamp: string) => timestamp.slice(0, 10);

// One searcher per kind. Each is a single PostgREST query scoped to the
// user; a failure in one degrades to fewer results, never a thrown error.

async function searchMessages(supabase: Admin, userId: string, query: string, w: Window, limit: number): Promise<HistoryHit[]> {
  let q = supabase
    .from('coach_messages')
    .select('id, display_text, created_at')
    .eq('user_id', userId)
    .eq('kind', 'turn')
    .in('role', ['user', 'assistant'])
    .textSearch('display_text', query, { type: 'websearch' });
  if (w.start) q = q.gte('created_at', w.start);
  if (w.endExclusive) q = q.lt('created_at', w.endExclusive);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ id: string; display_text: string | null; created_at: string }>)
    .filter(r => r.display_text)
    .map(r => ({ kind: 'message', sourceId: r.id, date: dayOf(r.created_at), snippet: snippetAround(r.display_text as string, query) }));
}

async function searchSessionSummaries(supabase: Admin, userId: string, query: string, w: Window, limit: number): Promise<HistoryHit[]> {
  let q = supabase
    .from('workout_sessions')
    .select('id, coach_summary, event_date')
    .eq('user_id', userId)
    .textSearch('coach_summary', query, { type: 'websearch' });
  if (w.start) q = q.gte('event_date', w.start);
  if (w.endExclusive) q = q.lt('event_date', w.endExclusive);
  const { data, error } = await q.order('event_date', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ id: string; coach_summary: string | null; event_date: string }>)
    .filter(r => r.coach_summary)
    .map(r => ({ kind: 'session_summary', sourceId: r.id, date: r.event_date, snippet: snippetAround(r.coach_summary as string, query) }));
}

async function searchReviews(supabase: Admin, userId: string, query: string, w: Window, limit: number): Promise<HistoryHit[]> {
  let q = supabase
    .from('reviews')
    .select('id, ai_commentary, created_at')
    .eq('user_id', userId)
    .textSearch('ai_commentary', query, { type: 'websearch' });
  if (w.start) q = q.gte('created_at', w.start);
  if (w.endExclusive) q = q.lt('created_at', w.endExclusive);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ id: string; ai_commentary: string | null; created_at: string }>)
    .filter(r => r.ai_commentary)
    .map(r => ({ kind: 'review', sourceId: r.id, date: dayOf(r.created_at), snippet: snippetAround(r.ai_commentary as string, query) }));
}

async function searchObjectives(supabase: Admin, userId: string, query: string, w: Window, limit: number): Promise<HistoryHit[]> {
  let q = supabase
    .from('objectives')
    .select('id, notes, updated_at')
    .eq('user_id', userId)
    .textSearch('notes', query, { type: 'websearch' });
  if (w.start) q = q.gte('updated_at', w.start);
  if (w.endExclusive) q = q.lt('updated_at', w.endExclusive);
  const { data, error } = await q.order('updated_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ id: string; notes: string | null; updated_at: string }>)
    .filter(r => r.notes)
    .map(r => ({ kind: 'objective', sourceId: r.id, date: dayOf(r.updated_at), snippet: snippetAround(r.notes as string, query) }));
}

const SEARCHERS: Record<HistoryKind, typeof searchMessages> = {
  message: searchMessages,
  session_summary: searchSessionSummaries,
  review: searchReviews,
  objective: searchObjectives,
};

export const searchHistoryTool: McpToolDef = {
  name: 'search_history',
  description:
    'Full-text search across past coach conversations, post-workout summaries, review commentary and ' +
    'objective notes. Web-search syntax: quote a phrase, prefix a word with - to exclude it. Returns the ' +
    'newest matches first with a short snippet around the match; use kinds to narrow the sources.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for (max 200 characters).' },
      start: { type: 'string', description: 'Only matches dated on or after this day, YYYY-MM-DD.' },
      end: { type: 'string', description: 'Only matches dated on or before this day, YYYY-MM-DD.' },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: [...HISTORY_KINDS] },
        description: 'Sources to search. Default: all four.',
      },
      limit: { type: 'integer', description: 'Matches to return across all kinds (default 10, max 30).' },
    },
    required: ['query'],
  },
  async run(supabase, userId, args) {
    const query = requireString(args, 'query');
    if (query.length > MAX_QUERY_CHARS) {
      throw new ToolInputError(`query must be at most ${MAX_QUERY_CHARS} characters.`);
    }
    const start = optionalDate(args, 'start');
    const end = optionalDate(args, 'end');
    if (start && end && end < start) throw new ToolInputError('end must be on or after start.');
    const kinds = parseKinds(args);
    const limit = optionalInt(args, 'limit', 10, 1, MAX_LIMIT);
    const window: Window = { start, endExclusive: end ? shiftDays(end, 1) : undefined };

    const perKind = await Promise.all(
      kinds.map(async kind => {
        try {
          return await SEARCHERS[kind](supabase, userId, query, window, limit);
        } catch (err) {
          console.warn(`[mcp] search_history: ${kind} search failed:`, err instanceof Error ? err.message : String(err));
          return [] as HistoryHit[];
        }
      }),
    );

    const results = perKind
      .flat()
      .sort((a, b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind))
      .slice(0, limit);
    return { query, results };
  },
};
