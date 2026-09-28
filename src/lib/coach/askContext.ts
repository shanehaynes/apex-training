import { format, parseISO } from 'date-fns';
import { sanitizeInlineText } from './prompt';

// "Ask the coach about this session" (lane E02, decision D-C08): the workout
// modal and the post-workout summary open the coach with that session
// pinned. The pin is a HIDDEN USER TURN — the model reads askCoachPrompt(),
// the thread shows askCoachDisplay() — never a prompt change, so the coach's
// system prompt (PROMPT_VERSION) does not move and the turn persists like any
// other: api_content is the hidden text, display_text the short line
// (useChat.sendMessage's `display` option; hydrateFromRows shows the line
// and replays the text).
//
// Pure: no React, no clock. The two surfaces build the request from the
// event they already hold; ChatSidebar sends it once the pane is free.

export interface AskCoachRequest {
  kind: 'session';
  /** The occurrence id (`base__date` for a recurring event) — what
   *  get_workout_detail takes; a series base id is accepted there too. */
  eventId: string;
  /** YYYY-MM-DD. */
  date: string;
  title: string;
  /** Where the button was: the calendar's workout modal, or the tracker's
   *  summary right after the athlete finished logging. */
  source: 'modal' | 'tracker';
}

/** Longest title the hidden text carries; the prompt's own inline cap. */
const TITLE_MAX = 120;

/** Only a calendar date reaches the model; anything else is reported as such. */
function safeDate(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : 'an unknown date';
}

/** An id is opaque to the athlete but is quoted to the model verbatim, so
 *  it gets the same treatment as any user-authored string. */
function safeId(id: string): string {
  return sanitizeInlineText(id, 200);
}

/**
 * The hidden text the model sees: which workout the athlete opened, from
 * where, which tools to call before answering, and how to behave with what
 * it finds. User-authored strings are sanitised exactly as the prompt
 * sanitises them (sanitizeInlineText), so a title can never open or close a
 * tagged block.
 */
export function askCoachPrompt(req: AskCoachRequest): string {
  const title = sanitizeInlineText(req.title, TITLE_MAX) || 'Untitled workout';
  const date = safeDate(req.date);
  const id = safeId(req.eventId);
  const opened = req.source === 'tracker'
    ? `I just finished tracking the workout "${title}" on ${date} (occurrence id ${id}) and opened you from its summary.`
    : `I opened the workout "${title}" on ${date} (occurrence id ${id}) from the calendar and asked you about it.`;
  const reads = req.source === 'tracker'
    ? `Before you answer, call get_workout_detail with event_id "${id}" and date "${date}", and get_session_summaries for ${date}, so you have the prescription, what I logged, and the session's own summary.`
    : `Before you answer, call get_workout_detail with event_id "${id}" and date "${date}" so you have the prescription and whatever was logged; if it was tracked, call get_session_summaries for ${date} too.`;
  return [
    opened,
    reads,
    'Keep to this session unless I widen the question myself.',
    'If I tell you how it felt or what hurt, offer to remember it with the memory tool — a confirm card I accept or decline — rather than deciding for me.',
    'If my next message is a question, answer that question; if I say nothing more, open with what you see in this session.',
  ].join(' ');
}

/** The line the thread shows in place of the hidden text. */
export function askCoachDisplay(req: AskCoachRequest): string {
  const title = sanitizeInlineText(req.title, TITLE_MAX) || 'Untitled workout';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.date) ? format(parseISO(req.date), 'EEE MMM d') : req.date;
  return `Asked about: ${title}, ${date}`;
}

/**
 * Whether ChatSidebar's effect should send the pinned request NOW. The pane
 * must be free (no turn in flight, no confirm card waiting — a user turn
 * cannot follow an unanswered tool_use), and the same request object must
 * not have been sent already: React StrictMode runs effects twice, and the
 * effect re-runs on every dep change while the request is still set.
 */
export function shouldSendAskCoach(
  request: AskCoachRequest | null,
  pane: { isLoading: boolean; pendingAction: unknown; lastSent: AskCoachRequest | null },
): request is AskCoachRequest {
  if (!request) return false;
  if (pane.isLoading || pane.pendingAction) return false;
  return pane.lastSent !== request;
}
