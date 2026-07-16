/**
 * Dev-only state bridge for driving agents (Playwright specs, drive CLI).
 *
 * Providers register snapshot getters; `window.__apex.state(key?)` returns
 * them as plain JSON. Every call site is guarded by `import.meta.env.DEV`,
 * which Vite replaces with `false` in production builds — the guarded code
 * and this module are dropped from the bundle (verified by grepping dist/).
 */
type StateGetter = () => unknown;

const getters = new Map<string, StateGetter>();

/** Register a snapshot getter under `key`; returns an unregister function. */
export function registerAgentState(key: string, getter: StateGetter): () => void {
  getters.set(key, getter);
  return () => {
    if (getters.get(key) === getter) getters.delete(key);
  };
}

// Round-trip so callers always get plain JSON: Dates become ISO strings,
// functions and undefined fields are stripped.
function snapshot(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __apex: unknown }).__apex = {
    version: 1,
    keys: () => [...getters.keys()],
    state(key?: string) {
      if (key !== undefined) {
        const get = getters.get(key);
        return get ? snapshot(get()) : undefined;
      }
      const all: Record<string, unknown> = {};
      for (const [k, get] of getters) all[k] = snapshot(get());
      return all;
    },
  };
}
