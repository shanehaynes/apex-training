// A stand-in for the anon Supabase client's select chain, as PostgREST
// answers it: filters are ignored, rows are sorted by the requested keys, and
// every response is capped at max_rows (1000) whatever the query asks for.

export const MAX_ROWS = 1000;

type Row = Record<string, unknown>;

export function createPostgrestStub() {
  const tables: Record<string, Row[]> = {};
  const ranges: Array<[string, number, number]> = [];
  const orders: Record<string, string[]> = {};
  const failPage: { table?: string; from?: number } = {};

  function query(table: string) {
    let from = 0;
    let to = Number.POSITIVE_INFINITY;
    const keys: Array<{ col: string; asc: boolean }> = [];
    const q = {
      select: () => q,
      in: () => q,
      eq: () => q,
      gte: () => q,
      lt: () => q,
      order: (col: string, opts?: { ascending?: boolean }) => {
        keys.push({ col, asc: opts?.ascending ?? true });
        orders[table] = keys.map(k => `${k.col} ${k.asc ? 'asc' : 'desc'}`);
        return q;
      },
      limit: (n: number) => { to = n - 1; return q; },
      range: (f: number, t: number) => { from = f; to = t; ranges.push([table, f, t]); return q; },
      then: (resolve: (r: { data: Row[] | null; error: { message: string } | null }) => void) => {
        if (failPage.table === table && failPage.from === from) {
          resolve({ data: null, error: { message: 'boom' } });
          return;
        }
        const rows = [...(tables[table] ?? [])].sort((a, b) => {
          for (const { col, asc } of keys) {
            const c = String(a[col]).localeCompare(String(b[col]), undefined, { numeric: true });
            if (c) return asc ? c : -c;
          }
          return 0;
        });
        resolve({ data: rows.slice(from, Math.min(to + 1, from + MAX_ROWS)), error: null });
      },
    };
    return q;
  }

  function reset() {
    for (const k of Object.keys(tables)) delete tables[k];
    for (const k of Object.keys(orders)) delete orders[k];
    ranges.length = 0;
    delete failPage.table;
    delete failPage.from;
  }

  return { client: { from: query }, tables, ranges, orders, failPage, reset };
}
