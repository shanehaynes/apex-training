// The catalog of models the coach may run on. The coach spends the USER'S
// OWN Anthropic key (server-only user_api_keys), so which model it uses is a
// direct line on their bill — hence a picker in the coach header rather than
// a constant. profiles.coach_model stores the choice; api/chat.ts,
// coachSummary.ts and review-cron.ts all resolve through resolveCoachModel().
//
// DEPENDENCY-FREE ON PURPOSE: api/chat.ts imports this file, and its import
// surface is restricted to api/_lib plus dependency-free src/lib/coach
// modules (see the warning in api/chat.ts).
//
// KEEPING THIS CURRENT: Anthropic ships models faster than this file changes,
// and nothing here fails loudly when it goes stale — a retired id just falls
// back to the default. `node scripts/check-models.mjs` diffs this catalog
// against GET /v1/models and is wired into scripts/supervisor-report.sh.
// Prices are NOT exposed by that API, so the $/MTok numbers below are
// hand-maintained: check them against the pricing page when adding an entry.

/** Request params that differ between models, spread into the SDK call. */
export interface CoachModelParams {
  /** Adaptive thinking. Omitted entirely on models that predate it. */
  thinking?: { type: 'adaptive' };
  /**
   * Effort, where the model's own default is not the level the coach is tuned
   * at. Opus 5.5 defaults to `medium`, one below every other entry's `high`.
   */
  output_config?: { effort: 'high' };
}

export interface CoachModelOption {
  id: string;
  /** Picker option text. */
  label: string;
  /** Short header badge. */
  badge: string;
  /** One line on what you trade away by picking it. */
  blurb: string;
  inputPerMTok: number;
  outputPerMTok: number;
  params: CoachModelParams;
}

// Ordered most → least capable, so the picker reads as a cost ladder.
//
// Adaptive thinking is the main request-shape difference, and it is a hard
// one: `thinking: {type:'adaptive'}` is REJECTED WITH A 400 on models
// older than Claude 4.6 (they used the now-removed budget_tokens form).
// Haiku 4.5 is such a model, so it runs with no thinking at all — which is
// also the point of choosing it. Never hoist `thinking` back out of these
// entries into a shared request literal.
export const COACH_MODELS: readonly CoachModelOption[] = [
  {
    // Thinking cannot be disabled on Opus 5.5 (a 400 at every effort level) and
    // its effort defaults to `medium`, so both are pinned here to match what
    // Opus 5 runs at by default.
    id: 'claude-opus-5-5',
    label: 'Opus 5.5',
    badge: 'claude opus 5.5',
    blurb: 'The newest Opus, 20% cheaper than Opus 5.',
    inputPerMTok: 4,
    outputPerMTok: 20,
    params: { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } },
  },
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    badge: 'claude opus 5',
    blurb: 'The default. The Opus the coach is evaluated on.',
    inputPerMTok: 5,
    outputPerMTok: 25,
    params: { thinking: { type: 'adaptive' } },
  },
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    badge: 'claude opus 4.8',
    blurb: 'The previous Opus, same price. Strong on planning-heavy turns.',
    inputPerMTok: 5,
    outputPerMTok: 25,
    params: { thinking: { type: 'adaptive' } },
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    badge: 'claude sonnet 5',
    blurb: 'About 60% cheaper. Handles most coaching turns well.',
    inputPerMTok: 2,
    outputPerMTok: 10,
    params: { thinking: { type: 'adaptive' } },
  },
  {
    // Dated id, not the bare `claude-haiku-4-5` alias: the alias is not
    // served by the Models API and 404s. scripts/check-models.mjs caught this.
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    badge: 'claude haiku 4.5',
    blurb: 'Cheapest by 5x and fastest. No extended thinking.',
    inputPerMTok: 1,
    outputPerMTok: 5,
    params: {},
  },
];

/** What a user who has never chosen runs on; profiles.coach_model stays null. */
export const DEFAULT_COACH_MODEL = 'claude-opus-5';

/**
 * Live models deliberately kept OUT of the picker, with the reason. Without
 * this, scripts/check-models.mjs would flag each one on every run forever and
 * the supervisor report would train us to ignore it. Adding an id here is how
 * you say "reviewed, declined" — deleting one puts it back in the queue.
 */
export const DECLINED_MODELS: Readonly<Record<string, string>> = {
  'claude-fable-5': 'Premium tier above Opus ($10/$50) — the wrong direction for a cost picker.',
  'claude-fable-5-1': 'Premium tier above Opus ($10/$50) — the wrong direction for a cost picker.',
  'claude-opus-4-7': 'Superseded by Opus 4.8 at identical pricing.',
  'claude-opus-4-6': 'Superseded by Opus 4.8 at identical pricing.',
  'claude-sonnet-4-6': 'Superseded by Sonnet 5 at identical pricing.',
};

/**
 * The allowlist every Anthropic call site goes through. Anything unrecognised
 * — a null column, a forged request body, an id retired out of the catalog —
 * resolves to the default rather than erroring, so removing a model from
 * COACH_MODELS is safe even while users still have it saved.
 */
export function resolveCoachModel(id: unknown): CoachModelOption {
  const match = typeof id === 'string' ? COACH_MODELS.find(m => m.id === id) : undefined;
  return match ?? defaultCoachModel();
}

export function defaultCoachModel(): CoachModelOption {
  const fallback = COACH_MODELS.find(m => m.id === DEFAULT_COACH_MODEL);
  // Unreachable while the models.test.ts invariant holds; throwing beats
  // silently running on whatever happens to be first in the array.
  if (!fallback) throw new Error(`DEFAULT_COACH_MODEL "${DEFAULT_COACH_MODEL}" is not in COACH_MODELS`);
  return fallback;
}

/** True for ids the profile PATCH may store. null (= follow default) is handled by the caller. */
export function isCoachModelId(id: unknown): id is string {
  return typeof id === 'string' && COACH_MODELS.some(m => m.id === id);
}

/** e.g. "$3/$15 per Mtok" — shown in the picker so the saving is visible at the point of choice. */
export function priceLabel(model: CoachModelOption): string {
  return `$${model.inputPerMTok}/$${model.outputPerMTok} per Mtok`;
}
