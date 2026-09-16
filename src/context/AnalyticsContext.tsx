import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deleteJson, getJson, patchJson, postJson } from '../lib/api';
import { supabase } from '../lib/supabaseClient';
import { useDebouncedReload } from '../hooks/useDebouncedReload';
import { DEFAULT_TILE_LAYOUT, type TileLayout } from '../lib/analytics/tiles';
import { upgradeSpec } from '../lib/analytics/spec';
import type { ChartDraft } from '../lib/analytics/draft';
import { registerAgentState } from '../dev/agentBridge';
import {
  AnalyticsContext,
  EMPTY_TILE_OPTIONS,
  type AnalyticsContextValue,
  type SaveTileResult,
  type TileOptions,
  type TileView,
} from './analytics';

// Saved dashboard tiles (phase 35, switched to the API by #152). Reads and
// writes both go through /api/analytics-tiles now: the server unfolds each
// stored spec into the draft the builder edits and serves the picker options
// alongside, so the browser never builds a spec and the phone and the web
// share one validation path (W9). Realtime stays a refresh TRIGGER only —
// the socket says a row changed, the endpoint says what it now is.
//
// Chart DATA (the aggregation behind each tile) deliberately does NOT live
// here either: useTileResults owns that per-view, and since #152 it is
// computed server-side — the browser's bare `.select('*')` was capped at
// PostgREST's 1000 rows, so a heavy user's numbers were quietly wrong.

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const intOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isInteger(v) ? v : fallback;

function parseLayout(raw: unknown): TileLayout {
  const l = isObject(raw) ? raw : {};
  return {
    x: intOr(l.x, DEFAULT_TILE_LAYOUT.x),
    y: intOr(l.y, DEFAULT_TILE_LAYOUT.y),
    w: intOr(l.w, DEFAULT_TILE_LAYOUT.w),
    h: intOr(l.h, DEFAULT_TILE_LAYOUT.h),
  };
}

/**
 * One tile from a 200 body. getJson/postJson do not inspect what they parse,
 * so every field is checked here — a malformed row becomes null (dropped)
 * rather than a render crash, and an unreadable spec keeps the row as an
 * error tile exactly as the old rowToTile did.
 */
function parseTile(raw: unknown): TileView | null {
  if (!isObject(raw) || typeof raw.id !== 'string') return null;
  const spec = upgradeSpec(raw.spec);
  return {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : (spec?.title ?? 'Invalid tile'),
    spec,
    draft: isObject(raw.draft) ? (raw.draft as unknown as ChartDraft) : null,
    layout: parseLayout(raw.layout),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

const parseStrings = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];

function parseOptions(raw: unknown): TileOptions {
  if (!isObject(raw)) return EMPTY_TILE_OPTIONS;
  return {
    categories: parseStrings(raw.categories),
    otherWorkoutTitles: parseStrings(raw.otherWorkoutTitles),
  };
}

/** Null when the body is not the GET's shape at all — the caller keeps what it has. */
function parseTilesPayload(raw: unknown): { tiles: TileView[]; options: TileOptions } | null {
  if (!isObject(raw) || !Array.isArray(raw.tiles)) return null;
  const tiles: TileView[] = [];
  for (const entry of raw.tiles) {
    const tile = parseTile(entry);
    if (tile) tiles.push(tile);
  }
  return { tiles, options: parseOptions(raw.options) };
}

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  const [tiles, setTiles] = useState<TileView[]>([]);
  const [options, setOptions] = useState<TileOptions>(EMPTY_TILE_OPTIONS);
  const [isLoading, setIsLoading] = useState(!!supabase);

  // Ordering guard. Every state-placing event takes a ticket; a refresh only
  // applies if nothing newer has landed while it was in flight. Without this
  // a slow refresh that started before a save could arrive after it and put
  // the pre-save tile back on screen.
  const issued = useRef(0);
  const placed = useRef(0);

  const refresh = useCallback(async () => {
    if (!supabase) {
      setTiles([]);
      setOptions(EMPTY_TILE_OPTIONS);
      setIsLoading(false);
      return;
    }
    const ticket = ++issued.current;
    try {
      const payload = parseTilesPayload(await getJson<unknown>('/api/analytics-tiles', 'Loading tiles'));
      if (ticket <= placed.current) return;          // a save (or newer read) already won
      if (!payload) {
        console.warn('[apex] Unexpected /api/analytics-tiles body — keeping the tiles on screen');
        return;
      }
      placed.current = ticket;
      setTiles(payload.tiles);
      setOptions(payload.options);
    } catch {
      // lib/api already logged and toasted; keeping the previous state beats
      // blanking a working dashboard on one failed refresh.
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const scheduleRefresh = useDebouncedReload(refresh);

  useEffect(() => {
    const sb = supabase;
    if (!sb) return;
    const channel = sb
      .channel('analytics-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'analytics_tiles' }, scheduleRefresh)
      .subscribe();
    return () => { sb.removeChannel(channel); };
  }, [scheduleRefresh]);

  const saveTile = useCallback(async (
    id: string,
    draft: ChartDraft,
    layout: TileLayout,
  ): Promise<SaveTileResult | null> => {
    let body: unknown;
    try {
      body = await postJson<unknown>('/api/analytics-tiles', { id, draft, layout }, 'Save tile');
    } catch {
      return null;
    }
    // A refusal is the server's to phrase; hand it back untouched.
    if (isObject(body) && body.ok === false && typeof body.problem === 'string') {
      return { ok: false, problem: body.problem };
    }
    const tile = parseTile(isObject(body) ? body.tile : null);
    if (!tile) {
      console.warn('[apex] Unexpected /api/analytics-tiles save body');
      scheduleRefresh();
      return null;
    }
    // Place the SERVER's tile — it carries the spec it built and the draft
    // that spec unfolds to, neither of which the browser computes any more.
    placed.current = ++issued.current;
    setTiles(prev => {
      const i = prev.findIndex(t => t.id === tile.id);
      if (i === -1) return [...prev, tile];
      const copy = [...prev];
      copy[i] = tile;
      return copy;
    });
    return { ok: true, tile };
  }, [scheduleRefresh]);

  const saveLayouts = useCallback(async (layouts: Array<{ id: string } & TileLayout>) => {
    const byId = new Map(layouts.map(l => [l.id, l]));
    setTiles(prev => prev.map(t => {
      const l = byId.get(t.id);
      return l ? { ...t, layout: { x: l.x, y: l.y, w: l.w, h: l.h } } : t;
    }));
    try {
      await patchJson('/api/analytics-tiles', { layouts }, 'Save layout');
    } catch {
      await refresh();
    }
  }, [refresh]);

  const removeTile = useCallback(async (id: string) => {
    setTiles(prev => prev.filter(t => t.id !== id));
    try {
      await deleteJson<{ id: string }>(`/api/analytics-tiles?id=${encodeURIComponent(id)}`, 'Delete tile');
      return true;
    } catch {
      await refresh();
      return false;
    }
  }, [refresh]);

  // Dev-only agent bridge: compiled out of production builds.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    return registerAgentState('analytics', () => ({
      tiles: tiles.map(t => ({
        id: t.id,
        title: t.title,
        valid: t.spec !== null,
        layout: t.layout,
        measures: t.spec?.series.map(s => s.measure) ?? [],
      })),
      isLoading,
    }));
  }, [tiles, isLoading]);

  const value = useMemo<AnalyticsContextValue>(
    () => ({ tiles, options, isLoading, saveTile, saveLayouts, removeTile }),
    [tiles, options, isLoading, saveTile, saveLayouts, removeTile],
  );

  return <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>;
}
