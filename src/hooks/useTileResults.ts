import { useEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import { postJson } from '../lib/api';
import { now } from '../lib/clock';
import { useAuth } from '../context/auth';
import { useBlocks } from '../context/blocks';
import { blockPeriod } from '../lib/blocks/period';
import type { ChartDraft } from '../lib/analytics/draft';
import type { ChartSpec } from '../lib/analytics/spec';
import type { TileResult } from '../lib/analytics/engine';

// Computed tiles, from the server (#152). Replaces useAnalyticsData, which
// pulled the raw rows into the tab and ran the engine there: the browser's
// `.select('*')` stopped at PostgREST's 1000-row default, so a heavy user's
// dashboard quietly showed wrong numbers. POST /api/analytics-compute pages
// every table and returns TileData — one call for a whole dashboard instead
// of eight table reads plus per-tile aggregation in the render path.
//
// Each consumer owns one instance: the dashboard grid sends every tile's
// spec, the tile builder sends its live draft (and gets the server's refusal
// text for a draft the web would not build). Results are keyed by the
// caller's own key, so a tile renders its own result and nothing else's.

/** One thing to compute: a saved tile's spec, or the builder's live draft. */
export interface TileRequest {
  /** The consumer's slot identity — a tile id, or 'preview'. */
  key: string;
  spec?: ChartSpec;
  draft?: ChartDraft;
}

/** Results by request key. `undefined` = still in flight; render a loading state. */
export type TileResults = Record<string, TileResult | undefined>;

/**
 * The server's batch cap (MAX_SPECS in api/_lib/handlers/analyticsCompute.ts),
 * mirrored rather than imported — nothing under src/ imports from api/. A
 * dashboard past this many tiles is sent as several calls.
 */
const MAX_COMPUTE_BATCH = 24;

/**
 * Content-keyed results kept beyond the visible set, so an undone edit or a
 * re-picked chip renders instantly. Comfortably above MAX_COMPUTE_BATCH: the
 * live set must never be the thing evicted, or the effect would refetch what
 * it just dropped.
 */
const CACHE_LIMIT = 64;

/** The dashboard grid: nothing to debounce, the specs are already saved. */
export const DASHBOARD_DEBOUNCE_MS = 0;
/** The builder's live preview, matching the phone's 300 ms closely enough. */
export const BUILDER_DEBOUNCE_MS = 400;

const FAILED: TileResult = { ok: false, problem: 'Could not load this chart just now.' };

/**
 * The cache identity of one request: its body WITHOUT the title, plus the day
 * and an HR/active-block salt. Renaming a tile cannot change a single number,
 * so a title-only edit must not spend a round trip — while a changed HR
 * setting or a new active block must, since both feed the computation
 * server-side. Key order is stable because each body is built by one code
 * path; were it ever not, the cost is one extra fetch, never a wrong render.
 */
function contentKeyOf(req: TileRequest, todayIso: string, salt: string): string {
  const body: Record<string, unknown> = { ...(req.spec ?? req.draft) };
  delete body.title;
  return JSON.stringify([body, todayIso, salt]);
}

/**
 * Everything outside the request that feeds the server's computation: the
 * HR settings, the active block, and how weights are read and labelled
 * (phase55 weight_unit / body_weight_lb) — a change to any must refetch.
 */
export function tileSalt(
  profile: { max_hr?: number | null; threshold_hr?: number | null; weight_unit?: string | null; body_weight_lb?: number | null } | null,
  activePeriod: { startDate: string; endDateExclusive: string } | null,
): string {
  return [
    profile?.max_hr ?? '',
    profile?.threshold_hr ?? '',
    profile?.weight_unit ?? '',
    profile?.body_weight_lb ?? '',
    activePeriod?.startDate ?? '',
    activePeriod?.endDateExclusive ?? '',
  ].join('|');
}

interface KeyedRequest extends TileRequest {
  contentKey: string;
}

export function useTileResults(requests: TileRequest[], debounceMs: number): TileResults {
  const { profile } = useAuth();
  const { activeBlock } = useBlocks();

  const [cache, setCache] = useState<Map<string, TileResult>>(() => new Map());
  const inFlight = useRef<Set<string>>(new Set());

  const todayIso = format(now(), 'yyyy-MM-dd');
  const activePeriod = useMemo(
    () => (activeBlock ? blockPeriod(activeBlock) : null),
    [activeBlock],
  );
  const salt = tileSalt(profile, activePeriod);

  const keyed: KeyedRequest[] = requests
    .filter(r => r.spec !== undefined || r.draft !== undefined)
    .map(r => ({ ...r, contentKey: contentKeyOf(r, todayIso, salt) }));

  // The effect's ONLY dependency: which content keys still need fetching.
  // Callers rebuild their request array every render, so depending on the
  // array itself would fire a request per keystroke even when nothing about
  // the computation changed.
  const pendingKey = keyed
    .filter(k => !cache.has(k.contentKey))
    .map(k => k.contentKey)
    .join('\n');

  useEffect(() => {
    // `keyed`, `todayIso` and `cache` are read from the closure of the render
    // that changed pendingKey — which is precisely the render whose missing
    // set this effect exists to fetch. Listing them as dependencies instead
    // would fire a request per keystroke, which is the thing the derived key
    // is here to prevent.
    const missing = [...new Map(
      keyed
        .filter(k => !cache.has(k.contentKey) && !inFlight.current.has(k.contentKey))
        .map(k => [k.contentKey, k] as const),
    ).values()];
    if (missing.length === 0) return;

    let cancelled = false;
    const today = todayIso;

    const merge = (entries: Array<[string, TileResult]>) => {
      if (cancelled) return;
      setCache(prev => {
        const next = new Map(prev);
        for (const [k, v] of entries) next.set(k, v);
        // Map iterates in insertion order: drop the oldest first so a long
        // builder session cannot grow this without bound.
        while (next.size > CACHE_LIMIT) {
          const oldest = next.keys().next().value;
          if (oldest === undefined) break;
          next.delete(oldest);
        }
        return next;
      });
    };

    const send = async (batch: KeyedRequest[]) => {
      // Exactly one of the two arrays per call — the endpoint rejects both.
      const body = batch[0].spec !== undefined
        ? { specs: batch.map(b => b.spec), today }
        : { drafts: batch.map(b => b.draft), today };
      for (const b of batch) inFlight.current.add(b.contentKey);
      try {
        const res = await postJson<unknown>('/api/analytics-compute', body, 'Loading charts');
        const tiles = (res as { tiles?: unknown })?.tiles;
        if (!Array.isArray(tiles) || tiles.length !== batch.length) {
          console.warn('[apex] Unexpected /api/analytics-compute body');
          merge(batch.map(b => [b.contentKey, FAILED]));
          return;
        }
        merge(batch.map((b, i) => [b.contentKey, tiles[i] as TileResult]));
      } catch {
        // Marked, not retried: the failure is cached under the content key,
        // so an unreachable endpoint costs one request per tile, not a loop.
        // Any edit mints a new key and tries again.
        merge(batch.map(b => [b.contentKey, FAILED]));
      } finally {
        for (const b of batch) inFlight.current.delete(b.contentKey);
      }
    };

    const timer = setTimeout(() => {
      const specs = missing.filter(m => m.spec !== undefined);
      const drafts = missing.filter(m => m.spec === undefined);
      for (const group of [specs, drafts]) {
        for (let i = 0; i < group.length; i += MAX_COMPUTE_BATCH) {
          send(group.slice(i, i + MAX_COMPUTE_BATCH));
        }
      }
    }, debounceMs);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [pendingKey, debounceMs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Looked up by the CURRENT content key, so a request whose spec or draft
  // just changed reads as pending rather than showing the previous answer.
  const results: TileResults = {};
  for (const k of keyed) results[k.key] = cache.get(k.contentKey);
  return results;
}
