// Shared paginated-select helper for service-role data access.
// Extracted from reviewData.ts so the MCP tools can reuse it.

const PAGE_SIZE = 1000;

export interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/** Every column T names, at whatever (wider) type the DB gives it. */
type Wire<T> = { [K in keyof T]-?: unknown };

/**
 * Drain a query page by page. Supabase caps unbounded selects at 1000 rows,
 * and PR detection scans a user's full log history — silently truncated
 * history would fabricate PRs.
 *
 * T is the domain row the caller wants. The query must yield every column T
 * names — a column T expects that the table lacks is a compile error at the
 * call site — and T may only narrow what it yields (literal unions for text
 * columns, structured jsonb), which is the one cast below.
 */
export async function fetchAllPages<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<PageResult<Wire<T>>>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${label} fetch failed: ${error.message}`);
    rows.push(...((data ?? []) as unknown as T[]));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}
