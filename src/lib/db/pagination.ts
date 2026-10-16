// Browser twin of api/_lib/pagination.ts, for reads on the anon client.
// PostgREST's max_rows (1000 locally in supabase/config.toml, and Supabase's
// hosted default) caps every response, so one select silently drops rows past
// the first 1000 — a partial history reads as the whole of it. Drain page by
// page instead; a page shorter than PAGE_SIZE is the last one.
//
// Order each query by its table's unique key: a total order keeps a row from
// landing on two pages or on none.

const PAGE_SIZE = 1000;

export async function fetchAllRows<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  /** Checked before each page and after each response: an aborted drain
   *  throws rather than fetching more or resolving with what it has. */
  signal?: AbortSignal,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    signal?.throwIfAborted();
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    signal?.throwIfAborted();
    if (error) throw new Error(`${label} load failed: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}
