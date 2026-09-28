// The coaching contract (lane D01): a bounded, athlete-owned text — "how I
// want to be coached" (cadence, tone, what to push on, what to leave alone)
// — stored in profiles.coach_contract and rendered into the live half of
// the chat prompt as <coaching_contract>. The athlete edits it directly in
// the notebook, or accepts an edit the coach proposes as a before/after card:
// from chat through the propose_contract_edit tool, or overnight through a
// reflection (coach_reflections). Nothing rewrites it silently (D-C02).
//
// This module is the pure, React-free vocabulary the handlers, the tool
// registry, the reflection cron and the notebook share: the bound, the
// normalization every writer applies, the equality every "did it change"
// check uses, and the client shape of a reflection row. It imports nothing
// at runtime on purpose: the API reaches it through api/'s Node ESM graph.

/** profiles.coach_contract's CHECK: at most 2000 characters. */
export const CONTRACT_MAX = 2000;

/** The resolutions a reflection's contract edit can take. */
export const REFLECTION_RESOLUTIONS = ['accepted', 'rejected'] as const;
export type ReflectionResolution = (typeof REFLECTION_RESOLUTIONS)[number];

export function isReflectionResolution(value: unknown): value is ReflectionResolution {
  return typeof value === 'string' && (REFLECTION_RESOLUTIONS as readonly string[]).includes(value);
}

/**
 * The contract as every writer stores it: trimmed, line endings normalized,
 * runs of blank lines collapsed to one. '' means "no contract" — the same
 * thing a null column means on read.
 */
export function normalizeContract(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Why a contract text cannot be stored, or null when it can. */
export function contractProblem(text: unknown): string | null {
  if (typeof text !== 'string') return 'coach_contract must be a string';
  if (normalizeContract(text).length > CONTRACT_MAX) return `coach_contract must be at most ${CONTRACT_MAX} characters`;
  return null;
}

/**
 * Whether two contract texts say the same thing: normalized, then compared
 * with inner whitespace collapsed, so a proposal that only re-wraps lines is
 * "no change" rather than an edit card the athlete has to read twice.
 */
export function contractsEqual(a: unknown, b: unknown): boolean {
  const fold = (t: unknown) => normalizeContract(t).replace(/\s+/g, ' ');
  return fold(a) === fold(b);
}

/** One reflection as /api/coach-reflections reports it (the row, verbatim). */
export interface CoachReflection {
  id: string;
  /** The day reflected on, YYYY-MM-DD (UTC). */
  day: string;
  status: 'pending' | 'submitted' | 'done' | 'failed' | 'resolved';
  /** The contract the proposal was made against ('' when there was none). */
  contract_before: string | null;
  /** The proposed contract; null when the reflection proposed no change. */
  contract_after: string | null;
  /** One or two sentences on why, for the card. */
  reason: string | null;
  /** coach_memory ids inserted unconfirmed by this reflection; confirm each through /api/coach-memory. */
  memory_proposal_ids: string[];
  error: string | null;
  created_at: string;
  completed_at: string | null;
  /** Set once nothing further is wanted from the athlete on this row. */
  resolved_at: string | null;
  resolution: ReflectionResolution | null;
}

/** True when the row still waits on the athlete's accept or reject. */
export function reflectionAwaitsAthlete(r: Pick<CoachReflection, 'status' | 'contract_after' | 'resolved_at'>): boolean {
  return r.status === 'done' && r.contract_after !== null && r.resolved_at === null;
}
