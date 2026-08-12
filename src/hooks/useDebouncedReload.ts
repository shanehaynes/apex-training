import { useCallback, useEffect, useRef } from 'react';

/** Matches the burst window a multi-row write produces. */
const DEFAULT_DELAY_MS = 250;

/**
 * Trailing-debounced reload trigger for realtime subscriptions.
 *
 * Supabase emits one `postgres_changes` event per changed ROW, so a single
 * batch write echoes N times — and each echo would otherwise refetch a whole
 * table, on every connected tab. Collapsing the burst into one reload is the
 * difference between one query and N per write.
 *
 * The returned callback is stable, so passing it as a subscription handler
 * does not churn the channel. The latest `fn` is always the one invoked, so
 * callers need not memoize it.
 */
export function useDebouncedReload(fn: () => void, delayMs: number = DEFAULT_DELAY_MS): () => void {
  const fnRef = useRef(fn);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fnRef.current = fn;
  });

  // Unmount only: a pending reload firing after teardown would set state on a
  // gone provider.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      fnRef.current();
    }, delayMs);
  }, [delayMs]);
}
