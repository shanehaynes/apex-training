import { ApiError, authHeaders, postJson } from '../api';
import { supabase } from '../supabaseClient';
import { createWireCollector } from '../coach/wire';
import type { CardioLogRow, SetLogRow, TrackedSection, WorkoutSessionRow } from '../db/types';
import type { WorkoutEvent } from '../../types/workout';
import { buildTrackerModel } from './plan';
import { DEFAULT_MAX_RETRY_MS } from './saveQueue';
import type { TrackedSectionGroup } from './plan';
import type { PersonalRecord, SessionScore, WorkoutScoreRecord } from './records';

// Data access for the workout tracker — the one module that knows where
// tracking data lives. Since W3 (docs/ios/backend-changes.md) the session
// model is built SERVER-SIDE: /api/workout-sessions `bootstrap` returns the
// resolved TrackedSectionGroup[] (plan × saved rows × last-session shadows)
// and `finish` returns PRs + the score record, so this client owns only its
// edits. Writes go through /api/workout-sessions (service role). Owns two
// fallbacks to an in-memory session built from the plan: with Supabase
// unconfigured, like completions are; and when the bootstrap fails (no signal
// at the gym, a 5xx), so the athlete can still log sets. A network error or
// an error status other than 402 toasts "Starting session failed" (postJson);
// a 402 or a malformed 200 falls back with only the console warning below.
// Either way a reopened finished session shows as a fresh one until the next
// load.

export type SessionInfo = Pick<
  WorkoutSessionRow,
  | 'started_at' | 'finished_at' | 'total_duration_seconds' | 'coach_summary'
  | 'template_id' | 'score_type' | 'score_time_seconds' | 'score_rounds' | 'score_reps'
  | 'note'
>;

export interface RemovedSetKey {
  section: TrackedSection;
  exerciseId: string;
  setNumber: number;
}

/** One exercise's note for this occurrence; an empty note deletes it. */
export interface ExerciseNoteEdit {
  section: TrackedSection;
  exerciseId: string;
  note: string;
}

export interface TrackerSessionData {
  session: SessionInfo;
  groups: TrackedSectionGroup[];
  /** Populated for an already-finished session (reopening the summary). */
  prs: PersonalRecord[];
  scoreRecord: WorkoutScoreRecord | null;
}

function inMemorySession(): SessionInfo {
  return {
    started_at: new Date().toISOString(),
    finished_at: null,
    total_duration_seconds: null,
    coach_summary: null,
    template_id: null,
    score_type: null,
    score_time_seconds: null,
    score_rounds: null,
    score_reps: null,
    note: null,
  };
}

interface BootstrapWire {
  session: WorkoutSessionRow;
  groups: TrackedSectionGroup[];
  prs?: PersonalRecord[];
  scoreRecord?: WorkoutScoreRecord | null;
}

/** Get-or-create the session and receive the resolved tracker model. */
export async function loadSession(event: WorkoutEvent): Promise<TrackerSessionData> {
  const offline = (): TrackerSessionData => ({
    session: inMemorySession(), groups: buildTrackerModel(event), prs: [], scoreRecord: null,
  });
  if (!supabase) return offline();

  try {
    const data = await postJson<BootstrapWire>(
      '/api/workout-sessions',
      { action: 'bootstrap', eventId: event.id, eventDate: event.date },
      'Starting session',
    );
    if (!data?.session || !Array.isArray(data.groups)) throw new Error('Malformed bootstrap response');
    return { session: data.session, groups: data.groups, prs: data.prs ?? [], scoreRecord: data.scoreRecord ?? null };
  } catch (err) {
    console.warn('[apex] Tracker load failed:', err);
    return offline();
  }
}

export interface SaveLogsOptions {
  /**
   * Let the request outlive the page — the hidden-tab flush, which the
   * browser would otherwise cancel on unload. Keepalive bodies are capped
   * (64 KiB) and a batch is far smaller than that.
   */
  keepalive?: boolean;
}

/**
 * An autosave failure, carrying the server's Retry-After (ms) on a 429 so
 * the save queue backs off at least that long.
 */
export class AutosaveError extends ApiError {
  retryAfterMs?: number;

  constructor(message: string, status: number | null, retryAfterMs?: number) {
    super(message, status);
    this.name = 'AutosaveError';
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Retry-After is seconds or an HTTP date; either becomes a delay in ms,
 * capped at the save queue's clamp so a hostile or absurd header cannot
 * park the retry for an hour.
 */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (Number.isNaN(ms)) return undefined;
  return Math.min(DEFAULT_MAX_RETRY_MS, Math.max(0, ms));
}

/**
 * Idempotent upsert of everything the user touched since the last flush.
 * Rejects with an AutosaveError on failure — the save queue keeps the keys
 * dirty and retries. It never toasts: whether a failure is worth telling the
 * user about is the save queue's call (useWorkoutSession), not the transport's. Its own fetch rather than postJson: the queue needs
 * `keepalive` and the 429's Retry-After, which the shared transport does
 * not expose.
 */
export async function saveLogs(
  eventId: string,
  eventDate: string,
  payload: {
    setLogs: SetLogRow[];
    cardioLogs: CardioLogRow[];
    removedSets: RemovedSetKey[];
    exerciseNotes?: ExerciseNoteEdit[];
    /** The whole session's note (phase55); absent = untouched, '' clears. */
    sessionNote?: string;
  },
  opts: SaveLogsOptions = {},
): Promise<void> {
  if (!supabase) return;
  const label = 'Autosave';
  let res: Response;
  try {
    res = await fetch('/api/workout-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ action: 'save', eventId, eventDate, ...payload }),
      keepalive: opts.keepalive === true,
    });
  } catch (err) {
    console.warn(`[apex] ${label} failed:`, err);
    throw new AutosaveError(`${label} failed`, null);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.warn(`[apex] ${label} failed (${res.status}):`, detail);
    throw new AutosaveError(
      detail || `${label} failed`,
      res.status,
      res.status === 429 ? parseRetryAfterMs(res.headers.get('Retry-After')) : undefined,
    );
  }
}

export interface FinishResult {
  totalDurationSeconds: number;
  prs: PersonalRecord[];
  scoreRecord: WorkoutScoreRecord | null;
}

/**
 * Stamp the session finished; zero-fill rows arrive pre-built by the caller.
 * Returns the server-computed duration plus the PRs and score record it
 * detected against full history, or null offline (caller keeps its locally
 * elapsed time and reports no records).
 */
export async function finishSession(
  eventId: string,
  eventDate: string,
  autofillRows: SetLogRow[],
  score?: { templateId: string } & SessionScore,
): Promise<FinishResult | null> {
  if (!supabase) return null;
  const data = await postJson<Partial<FinishResult>>(
    '/api/workout-sessions',
    { action: 'finish', eventId, eventDate, autofillRows, ...(score ? { score } : {}) },
    'Finishing workout',
  );
  if (typeof data?.totalDurationSeconds !== 'number') return null;
  return {
    totalDurationSeconds: data.totalDurationSeconds,
    prs: Array.isArray(data.prs) ? data.prs : [],
    scoreRecord: data.scoreRecord ?? null,
  };
}

/** What `edit-times` answers: the corrected times and the duration they make. */
export interface EditedSessionTimes {
  startedAt: string;
  finishedAt: string;
  totalDurationSeconds: number;
}

/**
 * Change when a finished, tracker-logged session started and finished
 * (rulings R4.1–R4.5 are the server's). Null offline. Rejects with an
 * ApiError carrying the server's reason — a quick-completed or synced
 * session, or a time outside the event's bounds — which the caller shows
 * verbatim; the shared transport's generic toast is suppressed for that.
 */
export async function editSessionTimes(
  eventId: string,
  eventDate: string,
  startedAt: string,
  finishedAt: string,
): Promise<EditedSessionTimes | null> {
  if (!supabase) return null;
  const data = await postJson<Partial<EditedSessionTimes>>(
    '/api/workout-sessions',
    { action: 'edit-times', eventId, eventDate, startedAt, finishedAt },
    'Changing workout times',
    { quiet: true },
  );
  if (typeof data?.totalDurationSeconds !== 'number' || typeof data.startedAt !== 'string' || typeof data.finishedAt !== 'string') {
    throw new ApiError('Malformed edit-times response', null);
  }
  return { startedAt: data.startedAt, finishedAt: data.finishedAt, totalDurationSeconds: data.totalDurationSeconds };
}

export interface ExerciseSwap {
  section: TrackedSection;
  /** The plan entry's id — unchanged by the swap, since logs key on it. */
  exerciseId: string;
  exerciseName: string;
  definitionId: string | null;
}

/**
 * Relabel one exercise's logs for this event+date onto a different movement,
 * keeping every set. The plan is untouched — a recurring series and its other
 * occurrences keep their prescription. Resolves false when there is no
 * backend to persist to, so callers can skip the reload.
 */
export async function swapLoggedExercise(
  eventId: string,
  eventDate: string,
  swap: ExerciseSwap,
): Promise<boolean> {
  if (!supabase) return false;
  await postJson('/api/workout-sessions', { action: 'swap-exercise', eventId, eventDate, ...swap }, 'Swapping exercise');
  return true;
}

/** Forget the session entirely — no resume, no history. */
export async function cancelSession(eventId: string, eventDate: string): Promise<void> {
  if (!supabase) return;
  await postJson('/api/workout-sessions', { action: 'cancel', eventId, eventDate }, 'Discarding workout');
}

/**
 * "Mark as Complete" quick path: the server logs every exercise at its
 * planned targets and stamps the session finished at the recommended
 * duration (W0). Server-side upserts ignore duplicates, so hand-logged rows
 * are never overwritten.
 */
export async function quickCompleteSession(event: WorkoutEvent): Promise<void> {
  if (!supabase) return;
  await postJson('/api/workout-sessions', {
    action: 'quick-complete',
    eventId: event.id,
    eventDate: event.date,
  }, 'Quick-completing workout');
}

/** Undo the quick path: delete system-filled rows, keep hand-entered logs. */
export async function quickUncompleteSession(eventId: string, eventDate: string): Promise<void> {
  if (!supabase) return;
  await postJson('/api/workout-sessions', { action: 'quick-uncomplete', eventId, eventDate }, 'Un-completing workout');
}

/**
 * Stream the coach's written summary for a finished session. The server
 * rebuilds the recap from the saved rows, streams NDJSON text events (the
 * chat wire format), and persists the result itself. `onText` receives the
 * running total. Throws when the request fails or comes back empty — the
 * summary popup degrades to PRs + the completed list in that case.
 */
export async function generateCoachSummary(
  eventId: string,
  eventDate: string,
  onText?: (fullText: string) => void,
): Promise<string> {
  if (!supabase) throw new Error('No backend');
  const res = await fetch('/api/coach-summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ eventId, eventDate }),
  });
  if (!res.ok || !res.body) {
    throw new ApiError(await res.text().catch(() => `coach summary failed: ${res.status}`), res.status);
  }
  const collector = createWireCollector(onText);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    collector.push(decoder.decode(value, { stream: true }));
  }
  collector.end();
  const text = collector.text.trim();
  if (!text) throw new Error('Empty summary response');
  return text;
}
