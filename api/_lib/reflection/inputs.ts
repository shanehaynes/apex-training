import type { getSupabaseAdmin } from '../supabaseAdmin.js';
import { listConfirmed, toPromptEntries } from '../coach/memory.js';
import { fetchPhysiologyInputs } from '../coach/physiology.js';
import { readCoachContract } from './contract.js';
import { computePhysiology, describePhysiology } from '../../../src/lib/physiology/index.js';
import type { MemoryPromptEntry } from '../../../src/lib/coach/memory.js';

// What one nightly reflection reads (lane D01): the day's completed sessions
// with the tracker's coach summary, that day's chat as the athlete saw it,
// the physiology panel as of that day, the confirmed memory, the memory
// proposals still waiting on a click (so the model is never asked to
// propose one twice), and the coaching contract. Every source degrades on
// its own: a table that is not there yet costs its section, never the
// reflection — except the two that decide whether there is anything to
// reflect on (sessions, messages), which throw so the cron records the
// failure rather than writing an empty "nothing happened" row.

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A completed session on the day: the completion row, plus the tracker's summary when one exists. */
export interface ReflectedSession {
  eventId: string;
  title: string;
  type: string;
  durationMinutes: number | null;
  /** The tracker's coach_summary for the session, when the athlete ran one. */
  coachSummary: string | null;
}

export interface ReflectedMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface ReflectionInputs {
  /** YYYY-MM-DD (UTC). */
  day: string;
  sessions: ReflectedSession[];
  messages: ReflectedMessage[];
  /** The rendered <physiology> block for the day, or ''. */
  physiology: string;
  memories: MemoryPromptEntry[];
  /** Texts of coach_memory rows proposed and not yet confirmed or archived. */
  pendingMemories: string[];
  contract: string;
}

/** Chat text the reflection reads: the newest messages up to this many characters. */
export const REFLECTION_CHAT_CHARS = 12_000;
/** One message's share of that budget. */
export const REFLECTION_MESSAGE_CHARS = 1_500;
/** Rows read before the character budget applies — a bound on the query, not the prompt. */
const MESSAGE_ROW_LIMIT = 200;

export function isReflectionDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** The UTC calendar day before `now` — what the nightly run reflects on. */
export function yesterdayUtc(now: Date): string {
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** True when the day holds something to reflect on; a rest day with no chat is skipped without a model call. */
export function hasReflectableActivity(inputs: Pick<ReflectionInputs, 'sessions' | 'messages'>): boolean {
  return inputs.sessions.length > 0 || inputs.messages.length > 0;
}

/**
 * The newest messages that fit the character budget, in conversation order.
 * Each is cut to its own share first, so one long briefing cannot be the
 * whole day.
 */
export function budgetMessages(messages: ReflectedMessage[]): ReflectedMessage[] {
  const kept: ReflectedMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = messages[i].text.length > REFLECTION_MESSAGE_CHARS
      ? `${messages[i].text.slice(0, REFLECTION_MESSAGE_CHARS)}…`
      : messages[i].text;
    if (used + text.length > REFLECTION_CHAT_CHARS) break;
    used += text.length;
    kept.push({ role: messages[i].role, text });
  }
  return kept.reverse();
}

async function fetchSessions(supabase: Admin, userId: string, day: string): Promise<ReflectedSession[]> {
  const [completions, sessions] = await Promise.all([
    supabase
      .from('workout_completions')
      .select('event_id, event_title, event_type, duration_minutes')
      .eq('user_id', userId)
      .eq('event_date', day)
      .eq('is_completed', true),
    supabase
      .from('workout_sessions')
      .select('event_id, coach_summary, total_duration_seconds')
      .eq('user_id', userId)
      .eq('event_date', day)
      .not('finished_at', 'is', null),
  ]);
  if (completions.error) throw new Error(`workout_completions fetch failed: ${completions.error.message}`);
  if (sessions.error) throw new Error(`workout_sessions fetch failed: ${sessions.error.message}`);

  type CompletionRow = { event_id: string; event_title: string | null; event_type: string | null; duration_minutes: number | null };
  type SessionRow = { event_id: string; coach_summary: string | null; total_duration_seconds: number | null };
  const byEvent = new Map<string, ReflectedSession>();
  for (const c of (completions.data ?? []) as CompletionRow[]) {
    byEvent.set(c.event_id, {
      eventId: c.event_id,
      title: c.event_title || 'workout',
      type: c.event_type || 'workout',
      durationMinutes: c.duration_minutes,
      coachSummary: null,
    });
  }
  for (const s of (sessions.data ?? []) as SessionRow[]) {
    const existing = byEvent.get(s.event_id);
    if (existing) {
      existing.coachSummary = s.coach_summary;
      if (existing.durationMinutes === null && s.total_duration_seconds !== null) {
        existing.durationMinutes = Math.round(s.total_duration_seconds / 60);
      }
    } else {
      // A finished tracker session whose completion row is missing still
      // happened; it just has no title of its own.
      byEvent.set(s.event_id, {
        eventId: s.event_id,
        title: 'workout',
        type: 'workout',
        durationMinutes: s.total_duration_seconds !== null ? Math.round(s.total_duration_seconds / 60) : null,
        coachSummary: s.coach_summary,
      });
    }
  }
  return [...byEvent.values()].sort((a, b) => a.eventId.localeCompare(b.eventId));
}

async function fetchMessages(supabase: Admin, userId: string, day: string): Promise<ReflectedMessage[]> {
  const { data, error } = await supabase
    .from('coach_messages')
    .select('role, display_text, created_at')
    .eq('user_id', userId)
    .eq('kind', 'turn')
    .not('display_text', 'is', null)
    .gte('created_at', `${day}T00:00:00.000Z`)
    .lt('created_at', `${nextDay(day)}T00:00:00.000Z`)
    .order('created_at', { ascending: true })
    .limit(MESSAGE_ROW_LIMIT);
  if (error) throw new Error(`coach_messages fetch failed: ${error.message}`);
  type Row = { role: string; display_text: string | null };
  const out: ReflectedMessage[] = [];
  for (const m of (data ?? []) as Row[]) {
    const text = (m.display_text ?? '').trim();
    if (!text || (m.role !== 'user' && m.role !== 'assistant')) continue;
    out.push({ role: m.role, text });
  }
  return budgetMessages(out);
}

async function physiologyBlock(supabase: Admin, userId: string, day: string): Promise<string> {
  try {
    return describePhysiology(computePhysiology(await fetchPhysiologyInputs(supabase, userId, day)));
  } catch (err) {
    console.warn('[reflection] physiology unavailable:', err instanceof Error ? err.message : err);
    return '';
  }
}

async function confirmedMemory(supabase: Admin, userId: string): Promise<MemoryPromptEntry[]> {
  try {
    return toPromptEntries(await listConfirmed(supabase, userId));
  } catch (err) {
    console.warn('[reflection] memory unavailable:', err instanceof Error ? err.message : err);
    return [];
  }
}

/** Texts of this user's memory proposals still awaiting a click — the dedupe set alongside the confirmed rows. */
export async function listPendingMemoryTexts(supabase: Admin, userId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('coach_memory')
    .select('content')
    .eq('user_id', userId)
    .is('confirmed_at', null)
    .is('archived_at', null);
  if (error) throw new Error(`coach_memory fetch failed: ${error.message}`);
  return ((data ?? []) as Array<{ content: string }>).map(r => r.content);
}

async function pendingMemory(supabase: Admin, userId: string): Promise<string[]> {
  try {
    return await listPendingMemoryTexts(supabase, userId);
  } catch (err) {
    console.warn('[reflection] pending memory unavailable:', err instanceof Error ? err.message : err);
    return [];
  }
}

async function contractText(supabase: Admin, userId: string): Promise<string> {
  try {
    return await readCoachContract(supabase, userId);
  } catch (err) {
    console.warn('[reflection] contract unavailable:', err instanceof Error ? err.message : err);
    return '';
  }
}

/** Everything one reflection reads for (user, day). Throws only when the sessions or the chat cannot be read. */
export async function fetchReflectionInputs(supabase: Admin, userId: string, day: string): Promise<ReflectionInputs> {
  const [sessions, messages, physiology, memories, pendingMemories, contract] = await Promise.all([
    fetchSessions(supabase, userId, day),
    fetchMessages(supabase, userId, day),
    physiologyBlock(supabase, userId, day),
    confirmedMemory(supabase, userId),
    pendingMemory(supabase, userId),
    contractText(supabase, userId),
  ]);
  return { day, sessions, messages, physiology, memories, pendingMemories, contract };
}
