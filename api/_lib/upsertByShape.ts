type UpsertResult = { error: { message: string; code?: string } | null };

/**
 * Run one upsert per distinct set of keys in `rows`. supabase-js sends a
 * batch as the union of its rows' columns, and PostgREST fills a column a
 * row omits with NULL — so a batch mixing rows that carry `is_warmup` with
 * rows that don't fails the NOT NULL check (23502). `defaultToNull: false`
 * would avoid the error but write the column default over an existing
 * row's value on conflict. Grouped by shape, each row updates exactly the
 * columns it carries, and a new row takes the table default for the rest.
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
  const results = await Promise.all([...groups.values()].map(batch => upsert(batch)));
  return results.find(r => r.error) ?? { error: null };
}
