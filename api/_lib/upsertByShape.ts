type UpsertResult = { error: { message: string; code?: string } | null };

/**
 * Run one upsert per distinct set of keys in `rows`. supabase-js sends a
 * batch as the union of its rows' columns, and PostgREST fills a column a
 * row omits with NULL — so a batch mixing rows that carry `is_warmup` with
 * rows that don't fails the NOT NULL check (23502). `defaultToNull: false`
 * would avoid the error but write the column default over an existing
 * row's value on conflict. Grouped by shape, each row updates exactly the
 * columns it carries, and a new row takes the table default for the rest.
 *
 * Groups run one after another, stopping at the first error: two
 * concurrent upserts sharing a conflict key could deadlock, or land in
 * either order. Not atomic across groups — a failed group leaves earlier
 * ones written, as a save's set, cardio and note writes already are.
 */
export async function upsertByShape<R extends Record<string, unknown>>(
  rows: R[],
  upsert: (batch: R[]) => PromiseLike<UpsertResult>,
): Promise<UpsertResult> {
  const groups = new Map<string, R[]>();
  for (const row of rows) {
    const shape = Object.keys(row).sort().join(',');
    const group = groups.get(shape);
    if (group) group.push(row);
    else groups.set(shape, [row]);
  }
  for (const batch of groups.values()) {
    const result = await upsert(batch);
    if (result.error) return result;
  }
  return { error: null };
}
