// Server-side column allowlists for the write endpoints. The client-side
// executors (src/lib/coach/tools.ts) and mapping layer already constrain
// what the app sends, but the API must not trust that: any authenticated
// caller can hit these endpoints directly. pickAllowed is the second
// containment layer — unknown keys are rejected loudly (Vercel deploys are
// atomic, so a legitimate client is never ahead of the server).

export function pickAllowed(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): { picked: Record<string, unknown>; rejected: string[] } {
  const picked: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (allowed.has(key)) picked[key] = value;
    else rejected.push(key);
  }
  return { picked, rejected };
}

// Mirrors what eventToRow (src/lib/schedule/mapping.ts) emits — pinned by
// api/__tests__/allowlist.test.ts so the two can't drift. user_id,
// created_at, updated_at are identity/server-managed, never client-writable.
export const EVENT_INSERT_COLUMNS: ReadonlySet<string> = new Set([
  'id',
  'type',
  'title',
  'subtitle',
  'date',
  'start_time',
  'end_time',
  'estimated_duration',
  'description',
  'warmup',
  'exercises',
  'cooldown',
  'difficulty',
  'location',
  'cover_image_url',
  'cardio_targets',
  'climbing_targets',
  'tags',
  'equipment',
  'is_recurring',
  'recurrence_rule',
  'recurring_frequency',
  'recurring_days',
  'recurring_end_date',
]);

export const EVENT_PATCH_COLUMNS: ReadonlySet<string> = new Set(
  [...EVENT_INSERT_COLUMNS].filter(c => c !== 'id'),
);

export const DEFINITION_INSERT_COLUMNS: ReadonlySet<string> = new Set([
  'id',
  'canonical_name',
  'aliases',
  'category',
  'muscle_groups',
  'equipment',
  'image_url',
  'technique_notes',
  'is_unilateral',
  'default_sets',
  'default_reps',
  'default_duration',
  'default_weight',
  'default_rest',
  'archived_at',
]);

export const DEFINITION_PATCH_COLUMNS: ReadonlySet<string> = new Set(
  [...DEFINITION_INSERT_COLUMNS].filter(c => c !== 'id'),
);

// Phase 19. Mirrors blockToRow / objectiveToRow (src/lib/blocks/mapping.ts) —
// pinned by api/__tests__/allowlist.test.ts. Ids are server-generated UUIDs
// (unlike events, whose ids are client slugs), so 'id' is absent from both
// sets. weekly_targets and required_capabilities are JSONB: pickAllowed guards
// the column NAME, and parseWeeklyTargets (src/lib/blocks/targets.ts) guards
// what is inside it.
export const BLOCK_INSERT_COLUMNS: ReadonlySet<string> = new Set([
  'objective_id',
  'name',
  'intent',
  'phase',
  'start_date',
  'end_date_exclusive',
  'weekly_targets',
]);

export const BLOCK_PATCH_COLUMNS: ReadonlySet<string> = BLOCK_INSERT_COLUMNS;

export const OBJECTIVE_INSERT_COLUMNS: ReadonlySet<string> = new Set([
  'name',
  'target_date',
  'discipline',
  'notes',
  'required_capabilities',
  'status',
]);

export const OBJECTIVE_PATCH_COLUMNS: ReadonlySet<string> = OBJECTIVE_INSERT_COLUMNS;
