// The model the product runs on when the user has not chosen one.
// api/chat.ts, api/_lib/handlers/coachSummary.ts, api/review-cron.ts, the
// coach header badge, and the eval harness's "production arm" all bottom out
// here — one bump moves everything together for every user whose
// profiles.coach_model is null.
//
// The full selectable catalog (and the resolver every call site uses) lives
// in ./models.ts; this file is the default's single source of truth.
//
// DEPENDENCY-FREE ON PURPOSE: api/chat.ts imports this file, and its import
// surface is restricted to api/_lib plus dependency-free src/lib/coach
// modules (see the warning in api/chat.ts).

import { DEFAULT_COACH_MODEL, defaultCoachModel } from './models';

export const COACH_MODEL = DEFAULT_COACH_MODEL;

/** Short badge text for the coach header, when no per-user choice applies. */
export const COACH_MODEL_DISPLAY = defaultCoachModel().badge;
