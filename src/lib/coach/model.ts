// The single source of truth for which Claude model the product runs on.
// api/chat.ts, api/_lib/handlers/coachSummary.ts, api/review-cron.ts (via
// REVIEW_MODEL), the sidebar's model badge, and the eval harness's
// "production arm" all read from here — one bump moves everything together.
//
// DEPENDENCY-FREE ON PURPOSE: api/chat.ts imports this file, and its import
// surface is restricted to api/_lib plus dependency-free src/lib/coach
// modules (see the warning in api/chat.ts).

export const COACH_MODEL = 'claude-opus-4-8';

/** Short badge text for the chat sidebar header. */
export const COACH_MODEL_DISPLAY = 'claude opus';
